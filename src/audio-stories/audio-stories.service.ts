import {
	ConflictException,
	HttpException,
	HttpStatus,
	Injectable,
	OnModuleInit,
	OnModuleDestroy,
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
import type { StoryAnalysisJob } from '../generated/prisma/client.js';
import { StoryAnalysisSchema, type StoryAnalysisResult } from '../ai/schemas/story-analysis.schema.js';
import { BadRequestException } from '@nestjs/common';
import { assertNoActiveJob, withStoryLock } from '../audio-generation/utils/audio-story-lock.js';
import { UpdateStoryCastDto } from './dto/update-story-cast.dto.js';
@Injectable()
export class AudioStoriesService implements OnModuleInit, OnModuleDestroy {
	private timer: ReturnType<typeof setInterval> | null = null;
	private scanning = false;
	private readonly running = new Set<string>();
	constructor(
		private readonly prisma: PrismaService,
		private readonly audioStoryAnalysisService: AudioStoryAnalysisService,
		private readonly storyParserService: StoryParserService,
		private readonly storyAnalysisValidator: StoryAnalysisValidatorService,
		private readonly config: ConfigService,
		private readonly usage: AiUsageService
	) {}

	async create(userId: number, dto: CreateAudioStoryDto) {
		return this.prisma.audioStory.create({
			data: {
				title: dto.title,
				content: dto.content,
				userId
			}
		});
	}

	async findAll(userId: number) {
		return this.prisma.audioStory.findMany({
			where: {
				userId
			},
			orderBy: {
				created_at: 'desc'
			}
		});
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

		return { ...story, analysisJob: await this.getLatestAnalysisJob(id, userId, false) };
	}

	async update(id: number, userId: number, dto: UpdateAudioStoryDto) {
		return withStoryLock(this.prisma, id, async tx => {
			const story = await tx.audioStory.findFirst({ where: { id, userId } });
			if (!story) throw new NotFoundException('Audio story not found');
			const contentChanged = dto.content !== undefined && dto.content !== story.content;
			if (contentChanged) {
				await assertNoActiveJob(tx, id);
				await tx.storyAnalysisJob.updateMany({
					where: { storyId: id, status: { in: ['QUEUED', 'PROCESSING', 'WAITING'] } },
					data: {
						status: 'CANCELLED',
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: new Date(),
						errorCode: 'SCRIPT_CHANGED',
						errorMessage: 'Script changed. Submit the new script for analysis.'
					}
				});
				if (['SINGLE_PENDING', 'SINGLE_PROCESSING'].includes(story.status))
					throw new ConflictException('Generation is already running');
			}
			return tx.audioStory.update({
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
			});
		});
	}

	async remove(id: number, userId: number) {
		await this.findOne(id, userId);

		return this.prisma.audioStory.delete({
			where: {
				id,
				userId
			}
		});
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
			source,
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
			source,
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

	async analyze(id: number, userId: number) {
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
			if (story.analysisStatus === 'COMPLETED' && StoryAnalysisSchema.safeParse(story.analysisResult).success) {
				const cached = await tx.storyAnalysisJob.findFirst({
					where: { storyId: id, contentHash: hash, status: 'COMPLETED' }
				});
				return (
					cached ??
					tx.storyAnalysisJob.create({
						data: {
							storyId: id,
							userId,
							contentHash: hash,
							contentSnapshot: story.content,
							status: 'COMPLETED',
							completedAt: new Date(),
							source: 'CACHE'
						}
					})
				);
			}
			await assertNoActiveJob(tx, id);
			try {
				await this.usage.consumeSubmission(tx, userId, 'analysis');
			} catch (error) {
				if (error instanceof AiCapacityError)
					throw new HttpException(
						{
							message: 'Analysis submission limit reached. Please try later.',
							nextRetryAt: error.nextRetryAt
						},
						HttpStatus.TOO_MANY_REQUESTS
					);
				throw error;
			}
			const activeCount = await tx.storyAnalysisJob.count({
				where: { userId, status: { in: ['QUEUED', 'PROCESSING', 'WAITING'] } }
			});
			if (activeCount >= this.usage.limit('ANALYSIS_USER_ACTIVE_JOBS', 2))
				throw new HttpException(
					'You already have analysis jobs in progress. Wait or cancel one.',
					HttpStatus.TOO_MANY_REQUESTS
				);
			const created = await tx.storyAnalysisJob.create({
				data: { storyId: id, userId, contentSnapshot: story.content, contentHash: hash }
			});
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
		return withStoryLock(this.prisma, storyId, async tx => {
			const job = await tx.storyAnalysisJob.findFirst({ where: { id: jobId, storyId, userId } });
			if (!job) throw new NotFoundException('Analysis job not found');
			if (!['QUEUED', 'PROCESSING', 'WAITING'].includes(job.status)) return this.jobDto(job);
			const cancelled = await tx.storyAnalysisJob.update({
				where: { id: jobId },
				data: {
					status: 'CANCELLED',
					leaseToken: null,
					leaseExpiresAt: null,
					nextRetryAt: null,
					completedAt: new Date(),
					errorCode: null,
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
	}

	private dispatch(jobId: string) {
		if (this.running.has(jobId)) return;
		this.running.add(jobId);
		setImmediate(() => {
			void this.processAnalysisJob(jobId)
				.catch(() => {
					/* An expired lease is picked up by the durable scanner. */
				})
				.finally(() => this.running.delete(jobId));
		});
	}

	async processAnalysisJob(jobId: string) {
		const leaseToken = randomUUID();
		const job = await this.prisma.$transaction(async tx => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73126, 0)`;
			const now = new Date();
			const candidate = await tx.storyAnalysisJob.findFirst({
				where: { id: jobId, OR: [{ status: 'QUEUED' }, { status: 'WAITING', nextRetryAt: { lte: now } }] }
			});
			if (!candidate) return null;
			const processors = await tx.storyAnalysisJob.count({
				where: { status: 'PROCESSING', leaseExpiresAt: { gt: now } }
			});
			if (processors >= this.usage.limit('ANALYSIS_GLOBAL_WORKERS', 2)) return null;
			const changed = await tx.storyAnalysisJob.updateMany({
				where: { id: jobId, status: candidate.status },
				data: {
					status: 'PROCESSING',
					leaseToken,
					leaseExpiresAt: new Date(Date.now() + 120_000),
					nextRetryAt: null,
					attempts: { increment: 1 }
				}
			});
			return changed.count === 1 ? candidate : null;
		});
		if (!job) return;
		const heartbeat = setInterval(() => {
			void this.prisma.storyAnalysisJob
				.updateMany({
					where: { id: jobId, status: 'PROCESSING', leaseToken },
					data: { leaseExpiresAt: new Date(Date.now() + 120_000) }
				})
				.catch(() => undefined);
		}, 15_000);
		heartbeat.unref();
		try {
			const parsed = this.storyParserService.parseScenes(job.contentSnapshot);
			const parserValidation = this.storyParserService.validateParsedScenes(parsed);
			let result: StoryAnalysisResult;
			let source = 'GEMINI_AI';
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
				} else result = await this.audioStoryAnalysisService.analyze(job.contentSnapshot, job.userId);
			} else result = await this.audioStoryAnalysisService.analyze(job.contentSnapshot, job.userId);
			const validation = this.storyAnalysisValidator.validate(result);
			if (!validation.valid || result.scenes.length > this.usage.limit('ANALYSIS_MAX_SCENES', 200))
				throw new UnprocessableEntityException('Analysis result is invalid or contains too many scenes');
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
				if (!current || !story) return;
				await assertNoActiveJob(tx, job.storyId);
				await this.syncCharacters(tx, job.storyId, result.characters);
				await this.syncScenes(tx, job.storyId, result.scenes);
				await tx.audioStory.update({
					where: { id: job.storyId },
					data: {
						analysisStatus: 'COMPLETED',
						analysisError: null,
						analysisResult: {
							...result,
							storyId: job.storyId,
							source,
							validation
						} as Prisma.InputJsonValue,
						analyzedAt: new Date(),
						analysisStartedAt: null,
						analysisAttemptId: null
					}
				});
				await tx.storyAnalysisJob.update({
					where: { id: jobId },
					data: {
						status: 'COMPLETED',
						source,
						leaseToken: null,
						leaseExpiresAt: null,
						completedAt: new Date(),
						errorCode: null,
						errorMessage: null
					}
				});
			});
		} catch (error) {
			const details = error as {
				status?: number | string;
				code?: number | string;
				response?: { status?: number };
				getStatus?: () => number;
				message?: string;
			};
			const status = Number(
				details?.status ?? details?.getStatus?.() ?? details?.response?.status ?? details?.code
			);
			const temporary =
				error instanceof AiCapacityError ||
				[408, 429, 500, 502, 503, 504].includes(status) ||
				/ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network|abort|timeout/i.test(details?.message ?? '');
			const malformed =
				error instanceof SyntaxError ||
				details?.code === 'INVALID_ANALYSIS_RESPONSE' ||
				details?.message?.includes('empty analysis');
			const retry = temporary || (malformed && job.attempts < 2);
			const seconds = Math.min(300, 30 * 2 ** Math.min(job.attempts, 5)) * (0.85 + Math.random() * 0.3);
			const retryHeader =
				(error as any)?.response?.headers?.get?.('retry-after') ??
				(error as any)?.response?.headers?.['retry-after'];
			const retryHint = Number(retryHeader);
			const retryDate = typeof retryHeader === 'string' ? Date.parse(retryHeader) : NaN;
			const hintedTime =
				Number.isFinite(retryHint) && retryHint > 0
					? Date.now() + retryHint * 1000
					: Number.isFinite(retryDate)
						? retryDate
						: 0;
			const nextRetryAt =
				error instanceof AiCapacityError
					? error.nextRetryAt
					: new Date(Math.max(Date.now() + seconds * 1000, hintedTime));
			const errorCode = temporary
				? status === 429
					? 'PROVIDER_RATE_LIMITED'
					: 'TEMPORARY_UNAVAILABLE'
				: 'ANALYSIS_FAILED';
			const message = retry
				? 'Analysis is temporarily unavailable. Automatic retry is scheduled.'
				: [401, 403].includes(status)
					? 'Analysis provider access is unavailable. Contact support.'
					: 'The story could not be analyzed. Review the script and try again.';
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
						completedAt: retry ? null : new Date()
					}
				});
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
		} finally {
			clearInterval(heartbeat);
		}
	}

	async scanAnalysisJobs() {
		if (this.scanning) return;
		this.scanning = true;
		try {
			await this.prisma.storyAnalysisJob.updateMany({
				where: { status: 'PROCESSING', leaseExpiresAt: { lte: new Date() } },
				data: {
					status: 'WAITING',
					leaseToken: null,
					leaseExpiresAt: null,
					nextRetryAt: new Date(),
					errorCode: 'WORKER_INTERRUPTED',
					errorMessage: 'Analysis was interrupted. Automatic retry is scheduled.'
				}
			});
			const pending = await this.prisma.storyAnalysisJob.findMany({
				where: { OR: [{ status: 'QUEUED' }, { status: 'WAITING', nextRetryAt: { lte: new Date() } }] },
				orderBy: { createdAt: 'asc' },
				take: 20,
				select: { id: true }
			});
			for (const job of pending) this.dispatch(job.id);
		} finally {
			this.scanning = false;
		}
	}

	async onModuleInit() {
		await this.scanAnalysisJobs();
		this.timer = setInterval(() => {
			void this.scanAnalysisJobs().catch(() => undefined);
		}, 10_000);
		this.timer.unref();
	}

	onModuleDestroy() {
		if (this.timer) clearInterval(this.timer);
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
		const characters = await tx.audioCharacter.findMany({ where: { storyId }, select: { id: true, name: true } });
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
