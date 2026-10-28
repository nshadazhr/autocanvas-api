import {
	finishAnalysisAttempt,
	finishOpenAnalysisAttempts,
	safeAnalysisDetail,
	providerErrorCode
} from '../ai/analysis/analysis-attempts.js';
import { AnalysisRun } from '../ai/analysis/analysis-runner.service.js';
import { classifyAnalysisError } from '../ai/analysis/analysis-errors.js';
import type { AnalysisProvider } from '../ai/analysis/analysis.types.js';
import { CreditsService } from '../credits/credits.service.js';
import {
	ConflictException,
	Injectable,
	Logger,
	OnModuleInit,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAudioStoryDto } from './dto/create-audio-story.dto.js';
import { UpdateAudioStoryDto } from './dto/update-audio-story.dto.js';
import { AudioStoryAnalysisService } from './audio-story-analysis.service.js';
import { StoryParserService } from './services/story-parser.service.js';
import { UnprocessableEntityException } from '@nestjs/common';
import { StoryAnalysisValidatorService } from './services/story-analysis-validator.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { randomUUID, createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AiUsageService } from '../ai/usage/ai-usage.service.js';
import { AiCapacityError } from '../ai/usage/ai-capacity.error.js';
import type { AudioStory, StoryAnalysisJob } from '../generated/prisma/client.js';
import { StoryAnalysisSchema, type StoryAnalysisResult } from '../ai/schemas/story-analysis.schema.js';
import { BadRequestException } from '@nestjs/common';
import { assertNoActiveJob, withStoryLock } from '../audio-generation/utils/audio-story-lock.js';
import { UpdateStoryCastDto } from './dto/update-story-cast.dto.js';
@Injectable()
export class AudioStoriesService implements OnModuleInit {
	private readonly logger = new Logger(AudioStoriesService.name);
	private readonly running = new Map<string, Promise<void>>();
	private readonly retryWaits = new Map<string, () => void>();
	constructor(
		private readonly prisma: PrismaService,
		private readonly audioStoryAnalysisService: AudioStoryAnalysisService,
		private readonly storyParserService: StoryParserService,
		private readonly storyAnalysisValidator: StoryAnalysisValidatorService,
		private readonly config: ConfigService,
		private readonly usage: AiUsageService,
		private readonly credits: CreditsService
	) {}

	async create(userId: number, dto: CreateAudioStoryDto) {
		return this.publicStory(
			await this.prisma.audioStory.create({
				data: {
					title: dto.title,
					content: dto.content,
					userId
				}
			})
		);
	}

	async findAll(userId: number) {
		const stories = await this.prisma.audioStory.findMany({
			where: {
				userId
			},
			orderBy: {
				created_at: 'desc'
			}
		});
		return stories.map(story => this.publicStory(story));
	}

	async findOne(id: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: {
				id,
				userId
			}
		});

		if (!story) {
			throw new NotFoundException('Audio story not found');
		}

		return { ...this.publicStory(story), analysisJob: await this.getLatestAnalysisJob(id, userId, false) };
	}

	async update(id: number, userId: number, dto: UpdateAudioStoryDto) {
		return withStoryLock(this.prisma, id, async tx => {
			const story = await tx.audioStory.findFirst({ where: { id, userId } });
			if (!story) throw new NotFoundException('Audio story not found');
			const contentChanged = dto.content !== undefined && dto.content !== story.content;
			if (contentChanged) {
				await assertNoActiveJob(tx, id);
				const cancelledJobs = await tx.storyAnalysisJob.findMany({
					where: { storyId: id, status: { in: ['QUEUED', 'PROCESSING', 'WAITING'] } },
					select: { id: true }
				});
				for (const job of cancelledJobs) {
					await this.credits.finish(tx, 'analysis:' + job.id, false);
					await finishOpenAnalysisAttempts(tx, job.id, 'CANCELLED', 'SCRIPT_CHANGED');
				}
				await tx.storyAnalysisJob.updateMany({
					where: { storyId: id, status: { in: ['QUEUED', 'PROCESSING', 'WAITING'] } },
					data: {
						status: 'CANCELLED',
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: new Date(),
						errorCode: 'SCRIPT_CHANGED',
						providerHttpStatus: null,
						errorMessage: 'Script changed. Submit the new script for analysis.'
					}
				});
				if (['SINGLE_PENDING', 'SINGLE_PROCESSING'].includes(story.status))
					throw new ConflictException('Generation is already running');
			}
			return this.publicStory(
				await tx.audioStory.update({
					where: { id },
					data: {
						title: dto.title,
						content: dto.content,
						...(contentChanged
							? {
									analysisResult: Prisma.DbNull,
									analyzedAt: null,
									analysisStatus: 'PENDING',
									analysisError: null,
									analysisStartedAt: null,
									analysisAttemptId: null
								}
							: {})
					}
				})
			);
		});
	}

	async remove(id: number, userId: number) {
		return withStoryLock(this.prisma, id, async tx => {
			const story = await tx.audioStory.findFirst({ where: { id, userId } });
			if (!story) throw new NotFoundException('Audio story not found');
			await assertNoActiveJob(tx, id);
			const jobs = await tx.storyAnalysisJob.findMany({
				where: { storyId: id, userId, status: { in: ['QUEUED', 'PROCESSING', 'WAITING'] } }
			});
			for (const job of jobs) await this.credits.finish(tx, 'analysis:' + job.id, false);
			if (story.status.startsWith('SINGLE_') && story.analysisAttemptId)
				await this.credits.finish(tx, 'single:' + story.analysisAttemptId, false);
			// Remove job items before their scenes: the composite scene FK prevents cascading story deletion.
			await tx.audioGenerationJob.deleteMany({ where: { storyId: id, userId } });
			return this.publicStory(await tx.audioStory.delete({ where: { id } }));
		});
	}

	/** Keep provider routing metadata available to admin diagnostics, not user APIs. */
	private publicStory(story: AudioStory) {
		return {
			...story,
			analysisResult: this.publicAnalysisResult(story.analysisResult)
		};
	}

	private publicAnalysisResult(analysisResult: Prisma.JsonValue | null): Prisma.JsonValue | null {
		if (!analysisResult || Array.isArray(analysisResult) || typeof analysisResult !== 'object')
			return analysisResult;
		const { source: _source, ...publicResult } = analysisResult as Prisma.JsonObject;
		return publicResult;
	}

	private jobDto(job: StoryAnalysisJob | null) {
		if (!job) return null;
		const {
			id,
			storyId,
			status,
			attempts,
			nextRetryAt,
			errorCode,
			errorMessage,
			createdAt,
			updatedAt,
			completedAt
		} = job;
		return {
			id,
			storyId,
			status,
			attempts,
			nextRetryAt,
			errorCode,
			errorMessage,
			createdAt,
			updatedAt,
			completedAt
		};
	}

	async getLatestAnalysisJob(storyId: number, userId: number, checkOwner = true) {
		if (
			checkOwner &&
			!(await this.prisma.audioStory.findFirst({ where: { id: storyId, userId }, select: { id: true } }))
		)
			throw new NotFoundException('Audio story not found');
		return this.jobDto(
			await this.prisma.storyAnalysisJob.findFirst({
				where: { storyId, userId },
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
			})
		);
	}

	private async cachedAnalysis(tx: Prisma.TransactionClient, story: AudioStory, hash: string) {
		if (story.analysisStatus !== 'COMPLETED' || !StoryAnalysisSchema.safeParse(story.analysisResult).success)
			return null;
		const cached = await tx.storyAnalysisJob.findFirst({
			where: { storyId: story.id, contentHash: hash, status: 'COMPLETED' }
		});
		return (
			cached ??
			tx.storyAnalysisJob.create({
				data: {
					storyId: story.id,
					userId: story.userId,
					contentHash: hash,
					contentSnapshot: story.content,
					status: 'COMPLETED',
					completedAt: new Date(),
					source: 'CACHE'
				}
			})
		);
	}

	async analyze(id: number, userId: number) {
		await this.audioStoryAnalysisService.assertEnabled();
		const job = await withStoryLock(this.prisma, id, async tx => {
			const story = await tx.audioStory.findFirst({ where: { id, userId } });
			if (!story || story.status.startsWith('SINGLE_')) throw new NotFoundException('Audio story not found');
			if (!story.content.trim() || story.content.length > this.usage.limit('ANALYSIS_MAX_CHARACTERS', 30_000))
				throw new BadRequestException('Script must contain between 1 and 30,000 characters');
			const active = await tx.storyAnalysisJob.findFirst({
				where: { storyId: id, status: { in: ['QUEUED', 'PROCESSING', 'WAITING'] } }
			});
			if (active) return active;
			const hash = createHash('sha256').update(story.content).digest('hex');
			const cached = await this.cachedAnalysis(tx, story, hash);
			if (cached) return cached;
			await assertNoActiveJob(tx, id);
			const created = await tx.storyAnalysisJob.create({
				data: { storyId: id, userId, contentSnapshot: story.content, contentHash: hash }
			});
			await this.credits.reserve(tx, userId, 'analysis:' + created.id, 'ANALYSIS', [], id);
			await tx.audioStory.update({
				where: { id },
				data: {
					analysisStatus: 'PROCESSING',
					analysisError: null,
					analysisStartedAt: new Date(),
					analysisAttemptId: created.id
				}
			});
			return created;
		});
		if (['QUEUED', 'WAITING'].includes(job.status)) this.dispatch(job.id);
		return this.jobDto(job);
	}

	async cancelAnalysis(storyId: number, userId: number, jobId: string) {
		const result = await withStoryLock(this.prisma, storyId, async tx => {
			const job = await tx.storyAnalysisJob.findFirst({ where: { id: jobId, storyId, userId } });
			if (!job) throw new NotFoundException('Analysis job not found');
			if (!['QUEUED', 'PROCESSING', 'WAITING'].includes(job.status)) return this.jobDto(job);
			await this.credits.finish(tx, 'analysis:' + jobId, false);
			await finishOpenAnalysisAttempts(tx, jobId, 'CANCELLED', 'USER_CANCELLED');
			const cancelled = await tx.storyAnalysisJob.update({
				where: { id: jobId },
				data: {
					status: 'CANCELLED',
					leaseToken: null,
					leaseExpiresAt: null,
					nextRetryAt: null,
					completedAt: new Date(),
					errorCode: null,
					providerHttpStatus: null,
					errorMessage: null
				}
			});
			await tx.audioStory.updateMany({
				where: { id: storyId, userId, analysisAttemptId: jobId },
				data: {
					analysisStatus: 'PENDING',
					analysisAttemptId: null,
					analysisStartedAt: null,
					analysisError: null
				}
			});
			return this.jobDto(cancelled);
		});
		if (result?.status === 'CANCELLED') this.retryWaits.get(jobId)?.();
		return result;
	}

	private dispatch(jobId: string) {
		if (this.running.has(jobId)) return;
		const task = this.processAnalysisJob(jobId).finally(() => this.running.delete(jobId));
		this.running.set(jobId, task);
		// The wait endpoint observes the result; prevent unhandled rejections when a browser disconnects.
		void task.catch(() => this.logger.error({ jobId, errorCode: 'ANALYSIS_WORKER_FAILED' }));
	}

	async waitForAnalysis(id: number, userId: number, jobId: string) {
		const task = this.running.get(jobId);
		const job = await this.prisma.storyAnalysisJob.findFirst({ where: { id: jobId, storyId: id, userId } });
		if (!job) throw new NotFoundException('Analysis job not found');
		if (task) await task;
		else if (['QUEUED', 'PROCESSING', 'WAITING'].includes(job.status)) {
			if (
				(job.leaseExpiresAt && job.leaseExpiresAt > new Date()) ||
				(!job.leaseExpiresAt && job.updatedAt.getTime() > Date.now() - 120_000)
			)
				throw new ServiceUnavailableException('Analysis is still running. Refresh this page shortly.');
			// No automatic resume after a worker restart. The user can submit again.
			await withStoryLock(this.prisma, id, async tx => {
				const changed = await tx.storyAnalysisJob.updateMany({
					where: {
						id: jobId,
						status: job.status,
						leaseToken: job.leaseToken,
						leaseExpiresAt: job.leaseExpiresAt,
						updatedAt: job.updatedAt
					},
					data: {
						status: 'FAILED',
						errorCode: 'WORKER_INTERRUPTED',
						providerHttpStatus: null,
						errorMessage: 'Analysis was interrupted. Please try again.',
						completedAt: new Date(),
						leaseToken: null,
						leaseExpiresAt: null,
						nextRetryAt: null
					}
				});
				if (changed.count) {
					await this.credits.finish(tx, 'analysis:' + jobId, false);
					await finishOpenAnalysisAttempts(tx, jobId, 'INTERRUPTED', 'WORKER_INTERRUPTED');
				}
				if (changed.count)
					await tx.audioStory.updateMany({
						where: { id, analysisAttemptId: jobId },
						data: {
							analysisStatus: 'FAILED',
							analysisError: 'Analysis was interrupted. Please try again.',
							analysisAttemptId: null,
							analysisStartedAt: null
						}
					});
			});
		}
		return this.jobDto(await this.prisma.storyAnalysisJob.findUniqueOrThrow({ where: { id: jobId } }));
	}

	async processAnalysisJob(jobId: string) {
		const pending = await this.prisma.storyAnalysisJob.findFirst({
			where: { id: jobId, status: { in: ['QUEUED', 'WAITING'] } }
		});
		if (!pending) return;
		let run: AnalysisRun;
		try {
			run = new AnalysisRun(await this.audioStoryAnalysisService.getConfiguration());
		} catch {
			// A setup failure happens before an attempt is claimed. Only fail the
			// exact pending version observed here, never a newly leased worker.
			await withStoryLock(this.prisma, pending.storyId, async tx => {
				const changed = await tx.storyAnalysisJob.updateMany({
					where: {
						id: jobId,
						status: pending.status,
						leaseToken: pending.leaseToken,
						updatedAt: pending.updatedAt
					},
					data: {
						status: 'FAILED',
						errorCode: 'ANALYSIS_SETUP_FAILED',
						providerHttpStatus: null,
						errorMessage: 'Analysis could not start. Please try again.',
						completedAt: new Date(),
						nextRetryAt: null,
						leaseToken: null,
						leaseExpiresAt: null
					}
				});
				if (!changed.count) return;
				await this.credits.finish(tx, 'analysis:' + jobId, false);
				await tx.audioStory.updateMany({
					where: { id: pending.storyId, analysisAttemptId: jobId },
					data: {
						analysisStatus: 'FAILED',
						analysisError: 'Analysis could not start. Please try again.',
						analysisAttemptId: null,
						analysisStartedAt: null
					}
				});
			});
			return;
		}
		while (await this.processAnalysisAttempt(jobId, run.current.model, run.current.provider, run)) {
			// The run advances only for eligible errors, within its captured limits.
		}
	}

	private async processAnalysisAttempt(
		jobId: string,
		model: string,
		provider: AnalysisProvider = 'gemini',
		run?: AnalysisRun
	): Promise<boolean> {
		const leaseToken = randomUUID();
		const job = await this.prisma.$transaction(async tx => {
			const now = new Date();
			const candidate = await tx.storyAnalysisJob.findFirst({
				where: { id: jobId, OR: [{ status: 'QUEUED' }, { status: 'WAITING', nextRetryAt: { lte: now } }] }
			});
			if (!candidate) return null;
			const changed = await tx.storyAnalysisJob.updateMany({
				where: { id: jobId, status: candidate.status },
				data: {
					status: 'PROCESSING',
					leaseToken,
					leaseExpiresAt: new Date(Date.now() + 120_000),
					nextRetryAt: null,
					errorCode: null,
					providerHttpStatus: null,
					errorMessage: null,
					attempts: { increment: 1 }
				}
			});
			return changed.count === 1 ? candidate : null;
		});
		if (!job) return false;
		let providerRequestFailed = false;
		let attemptId: string | null = null;
		let callEndedAt: Date | undefined;
		let resultValidated = false;
		const analyze = async () => {
			try {
				return await this.audioStoryAnalysisService.analyze(
					job.contentSnapshot,
					job.userId,
					model,
					provider,
					async () => {
						const attempt = await withStoryLock(this.prisma, job.storyId, async tx => {
							const owner = await tx.storyAnalysisJob.findFirst({
								where: { id: jobId, status: 'PROCESSING', leaseToken },
								select: { id: true }
							});
							if (!owner) throw new Error('Analysis ownership expired before provider dispatch');
							return tx.storyAnalysisAttempt.create({
								data: {
									jobId,
									sequence: job.attempts + 1,
									provider,
									model,
									kind: run?.current.kind ?? 'INITIAL',
									startedAt: new Date()
								}
							});
						});
						attemptId = attempt.id;
					}
				);
			} catch (error) {
				providerRequestFailed = true;
				throw error;
			} finally {
				callEndedAt = new Date();
				if (attemptId)
					await this.prisma.storyAnalysisAttempt.updateMany({
						where: { id: attemptId },
						data: { responseAt: callEndedAt }
					});
			}
		};
		try {
			const parsed = this.storyParserService.parseScenes(job.contentSnapshot);
			const parserValidation = this.storyParserService.validateParsedScenes(parsed);
			let result: StoryAnalysisResult;
			let source = provider === 'gemini' ? 'GEMINI_AI' : 'OPENAI_AI';
			if (parserValidation.valid) {
				const local = {
					characters: [
						...new Map(
							parsed.map(scene => [scene.speakerName, { name: scene.speakerName, gender: scene.gender }])
						).values()
					],
					scenes: parsed.map(scene => ({
						sceneOrder: scene.sceneNumber,
						speakerName: scene.speakerName,
						text: scene.text,
						language: 'hi-IN',
						emotion: scene.emotion,
						style: scene.style
					}))
				};
				const validation = StoryAnalysisSchema.safeParse(local);
				if (validation.success && this.storyAnalysisValidator.validate(validation.data).valid) {
					result = validation.data;
					source = 'LOCAL_PARSER';
				} else result = await analyze();
			} else result = await analyze();
			const validation = this.storyAnalysisValidator.validate(result);
			if (!validation.valid || result.scenes.length > this.usage.limit('ANALYSIS_MAX_SCENES', 200))
				throw new UnprocessableEntityException('Analysis result is invalid or contains too many scenes');
			resultValidated = true;
			const savedResult = { ...result, storyId: job.storyId, source, validation } as Prisma.InputJsonValue;
			await withStoryLock(this.prisma, job.storyId, async tx => {
				const current = await tx.storyAnalysisJob.findFirst({
					where: { id: jobId, status: 'PROCESSING', leaseToken }
				});
				const story = await tx.audioStory.findFirst({
					where: {
						id: job.storyId,
						userId: job.userId,
						content: job.contentSnapshot,
						analysisAttemptId: jobId
					}
				});
				if (!current || !story) {
					if (attemptId)
						await finishAnalysisAttempt(
							tx,
							attemptId,
							'INTERRUPTED',
							{ errorCategory: 'OWNERSHIP_LOST' },
							callEndedAt
						);
					return;
				}
				await assertNoActiveJob(tx, job.storyId);
				await this.credits.finish(tx, 'analysis:' + jobId, true);
				await this.syncCharacters(tx, job.storyId, result.characters);
				await this.syncScenes(tx, job.storyId, result.scenes);
				await tx.audioStory.update({
					where: { id: job.storyId },
					data: {
						analysisStatus: 'COMPLETED',
						analysisError: null,
						analysisResult: savedResult,
						analyzedAt: new Date(),
						analysisStartedAt: null,
						analysisAttemptId: null
					}
				});
				await tx.storyAnalysisJob.update({
					where: { id: jobId },
					data: {
						status: 'COMPLETED',
						resultSnapshot: savedResult,
						successfulProvider: attemptId ? provider : null,
						successfulModel: attemptId ? model : null,
						source,
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: new Date(),
						errorCode: null,
						providerHttpStatus: null,
						errorMessage: null
					}
				});
				if (attemptId) await finishAnalysisAttempt(tx, attemptId, 'COMPLETED', {}, callEndedAt);
			});
		} catch (error) {
			const details = error as {
				status?: number | string;
				code?: number | string;
				response?: { status?: number };
				getStatus?: () => number;
				message?: string;
				nonRetryable?: boolean;
			};
			const classified = classifyAnalysisError(error);
			const status = classified.httpStatus;
			const next = providerRequestFailed ? (run?.afterFailure(error) ?? null) : null;
			const retry = !!next;
			const nextRetryAt = new Date(Date.now() + (next?.delayMs ?? 0));
			const errorCode = {
				CONFIGURATION: 'PROVIDER_CONFIGURATION_ERROR',
				BUSY: 'PROVIDER_BUSY',
				RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
				QUOTA_EXHAUSTED: 'PROVIDER_QUOTA_EXHAUSTED',
				ACCESS: 'PROVIDER_ACCESS_DENIED',
				NETWORK: 'NETWORK_ERROR',
				INVALID_RESPONSE: 'ANALYSIS_FAILED',
				FAILED: error instanceof AiCapacityError ? 'APP_CAPACITY_LIMIT' : 'ANALYSIS_FAILED'
			}[classified.kind];
			const messages: Record<string, string> = {
				PROVIDER_CONFIGURATION_ERROR:
					'The provider is disabled or its API key is invalid or unavailable. Contact an administrator.',
				PROVIDER_BUSY: retry
					? 'The analysis service is busy. Trying again automatically.'
					: 'The analysis service is busy. Please try again later.',
				PROVIDER_QUOTA_EXHAUSTED: retry
					? 'Analysis provider capacity is unavailable. Trying an alternative provider.'
					: 'The analysis provider quota was exhausted. Please try again later.',
				APP_CAPACITY_LIMIT: 'Analysis usage or capacity limit reached. Please try again later.',
				PROVIDER_RATE_LIMITED: retry
					? 'Analysis provider capacity is unavailable. Trying an alternative provider.'
					: 'The analysis provider quota or rate limit was reached. Please try again later.',
				PROVIDER_ACCESS_DENIED: 'Analysis provider access is unavailable. Contact support.',
				NETWORK_ERROR: 'The analysis provider could not be reached or the request timed out. Please try again.',
				ANALYSIS_FAILED: 'The story could not be analyzed. Review the script and try again.'
			};
			const message = messages[errorCode];
			// Metadata only: never log scripts, API keys, tokens or raw provider responses.
			this.logger.warn({
				jobId,
				errorCode,
				providerStatus: status,
				provider,
				model,
				attempts: job.attempts + 1,
				nextRetryAt: retry ? nextRetryAt.toISOString() : null
			});

			await withStoryLock(this.prisma, job.storyId, async tx => {
				const updated = await tx.storyAnalysisJob.updateMany({
					where: { id: jobId, status: 'PROCESSING', leaseToken },
					data: {
						status: retry ? 'WAITING' : 'FAILED',
						nextRetryAt: retry ? nextRetryAt : null,
						leaseToken: null,
						leaseExpiresAt: null,
						errorCode,
						errorMessage: message,
						providerHttpStatus:
							providerRequestFailed &&
							!details?.nonRetryable &&
							Number.isInteger(status) &&
							status !== null &&
							status >= 100 &&
							status <= 599
								? status
								: null,
						completedAt: retry ? null : new Date()
					}
				});
				if (attemptId)
					await finishAnalysisAttempt(
						tx,
						attemptId,
						updated.count ? 'FAILED' : 'INTERRUPTED',
						{
							errorCategory: updated.count
								? resultValidated
									? 'COMMIT_FAILED'
									: providerRequestFailed
										? classified.kind
										: 'VALIDATION'
								: 'OWNERSHIP_LOST',
							providerHttpStatus: providerRequestFailed && !details?.nonRetryable ? status : null,
							providerErrorCode: providerErrorCode(error),
							errorMessage: safeAnalysisDetail(error)
						},
						callEndedAt
					);
				if (updated.count && !retry) await this.credits.finish(tx, 'analysis:' + jobId, false);
				if (updated.count)
					await tx.audioStory.updateMany({
						where: { id: job.storyId, analysisAttemptId: jobId },
						data: {
							analysisStatus: retry ? 'PROCESSING' : 'FAILED',
							analysisError: message,
							...(retry ? {} : { analysisAttemptId: null, analysisStartedAt: null })
						}
					});
			});
			if (retry) {
				// Backup models run immediately. Only bounded primary retries wait.
				await this.waitForRetry(jobId, nextRetryAt);
			}
			return retry;
		}
		return false;
	}

	private async waitForRetry(jobId: string, at: Date) {
		const delay = Math.max(0, at.getTime() - Date.now());
		if (!delay) return;
		await new Promise<void>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				this.retryWaits.delete(jobId);
				resolve();
			};
			const timer = setTimeout(done, delay);
			this.retryWaits.set(jobId, done);
			// One read closes the cancellation-before-registration race; no polling.
			void this.prisma.storyAnalysisJob
				.findFirst({ where: { id: jobId, status: 'WAITING' }, select: { id: true } })
				.then(job => {
					if (!job) done();
				})
				.catch(error => {
					clearTimeout(timer);
					this.retryWaits.delete(jobId);
					reject(error);
				});
		});
	}

	async onModuleInit() {
		// Old jobs are not resumed automatically. Expired workers finish with a clear error.
		const stale = await this.prisma.storyAnalysisJob.findMany({
			where: {
				OR: [
					{ status: { in: ['QUEUED', 'WAITING'] }, updatedAt: { lte: new Date(Date.now() - 120_000) } },
					{ status: 'PROCESSING', leaseExpiresAt: { lte: new Date() } }
				]
			},
			select: { id: true, storyId: true, userId: true }
		});
		for (const job of stale) await this.waitForAnalysis(job.storyId, job.userId, job.id);
	}

	private async syncCharacters(
		tx: Prisma.TransactionClient,
		storyId: number,
		characters: StoryAnalysisResult['characters']
	) {
		for (const character of characters) {
			await tx.audioCharacter.upsert({
				where: {
					storyId_name: {
						storyId,
						name: character.name
					}
				},
				create: {
					storyId,
					name: character.name,
					gender: character.gender,
					voiceId: null
				},
				update: {
					gender: character.gender
				}
			});
		}
	}

	private async syncScenes(tx: Prisma.TransactionClient, storyId: number, scenes: StoryAnalysisResult['scenes']) {
		const characters = await tx.audioCharacter.findMany({
			where: { storyId },
			select: { id: true, name: true }
		});
		const characterMap = new Map(characters.map(character => [character.name, character.id]));
		const existingScenes = await tx.audioScene.findMany({ where: { storyId, sceneOrder: { gt: 0 } } });
		const existingMap = new Map(existingScenes.map(scene => [scene.sceneOrder, scene]));
		const incoming = new Set(scenes.map(scene => scene.sceneOrder));
		for (const existing of existingScenes) {
			if (!incoming.has(existing.sceneOrder))
				await tx.audioScene.update({ where: { id: existing.id }, data: { sceneOrder: -existing.id } });
		}
		for (const scene of scenes) {
			const existing = existingMap.get(scene.sceneOrder);
			const data = {
				storyId,
				sceneOrder: scene.sceneOrder,
				speakerName: scene.speakerName,
				characterId: characterMap.get(scene.speakerName) ?? null,
				text: scene.text,
				language: scene.language,
				emotion: scene.emotion,
				style: scene.style
			};
			const unchanged =
				existing &&
				existing.speakerName === scene.speakerName &&
				existing.text === scene.text &&
				existing.language === scene.language &&
				existing.emotion === scene.emotion &&
				existing.style === scene.style;
			if (unchanged) continue;
			if (existing)
				await tx.audioScene.update({ where: { id: existing.id }, data: { sceneOrder: -existing.id } });
			await tx.audioScene.create({ data });
		}
	}

	async updateCast(storyId: number, userId: number, dto: UpdateStoryCastDto) {
		return withStoryLock(this.prisma, storyId, async tx => {
			const story = await tx.audioStory.findFirst({
				where: { id: storyId, userId }
			});

			if (!story) {
				throw new NotFoundException('Audio story not found');
			}

			await assertNoActiveJob(tx, storyId);
			if (story.analysisStatus !== 'COMPLETED' || !story.analysisResult) {
				throw new BadRequestException('Story analysis must be completed before assigning voices.');
			}

			const analyzedCharacters =
				(
					story.analysisResult as {
						characters?: { name: string }[];
					}
				).characters ?? [];

			const allowedNames = new Set(analyzedCharacters.map(character => character.name));

			const submittedNames = dto.characters.map(character => character.name);

			if (
				new Set(submittedNames).size !== submittedNames.length ||
				dto.characters.some(character => !allowedNames.has(character.name))
			) {
				throw new BadRequestException('Invalid or duplicate characters in cast.');
			}

			const voiceIds = [
				...new Set(dto.characters.map(character => character.voiceId).filter((id): id is number => id != null))
			];

			const activeVoices = await tx.voice.findMany({
				where: {
					id: { in: voiceIds },
					isActive: true
				},
				select: { id: true }
			});

			if (activeVoices.length !== voiceIds.length) {
				throw new BadRequestException('One or more selected voices are invalid or inactive.');
			}

			for (const character of dto.characters) {
				await tx.audioCharacter.upsert({
					where: {
						storyId_name: {
							storyId,
							name: character.name
						}
					},
					create: {
						storyId,
						name: character.name,
						gender: character.gender,
						voiceId: character.voiceId ?? null
					},
					update: {
						gender: character.gender,
						...(character.voiceId !== undefined ? { voiceId: character.voiceId } : {})
					}
				});
			}

			return tx.audioCharacter.findMany({
				where: {
					storyId,
					name: { in: submittedNames }
				},
				select: {
					id: true,
					name: true,
					gender: true,
					voiceId: true
				},
				orderBy: { id: 'asc' }
			});
		});
	}

	async getCast(storyId: number, userId: number) {
		const story = await this.findOne(storyId, userId);

		if (story.analysisStatus !== 'COMPLETED' || !story.analysisResult) {
			return [];
		}

		const analysis = story.analysisResult as {
			characters?: { name: string }[];
		};

		const characterNames = [...new Set((analysis.characters ?? []).map(character => character.name))];

		if (characterNames.length === 0) {
			return [];
		}

		return this.prisma.audioCharacter.findMany({
			where: {
				storyId,
				name: { in: characterNames }
			},
			select: {
				id: true,
				name: true,
				gender: true,
				voiceId: true
			},
			orderBy: {
				id: 'asc'
			}
		});
	}
}
