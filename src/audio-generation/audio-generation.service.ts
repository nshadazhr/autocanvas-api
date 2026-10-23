import { sceneDownloadFilename } from './utils/scene-download-filename.js';
import { safeAiError } from '../ai/usage/safe-ai-error.js';
import { AiCapacityError } from '../ai/usage/ai-capacity.error.js';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GeminiTtsService } from './providers/gemini-tts.service.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GeminiKeysUnavailableError } from './errors/gemini-keys-unavailable.error.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mergeWavBuffers } from './utils/wav-merge.util.js';
import { ZipArchive } from 'archiver';
import { PassThrough } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { buildStylePrompt } from './providers/gemini-tts-prompt.builder.js';
import { classifyGeminiTtsError, shouldRetryWithNeutralPrompt } from './utils/gemini-tts-error.util.js';
import { StorageService } from '../storage/storage.service.js';
import { Readable } from 'node:stream';
import { assertNoActiveJob, withStoryLock } from './utils/audio-story-lock.js';
import { isCurrentSceneAudio, sceneAudioRevision } from './utils/scene-audio-revision.js';
@Injectable()
export class audioGenerationService implements OnModuleInit, OnModuleDestroy {
	constructor(
		private readonly prisma: PrismaService,
		private readonly geminiTtsService: GeminiTtsService,
		private readonly configService: ConfigService,
		private readonly storageService: StorageService
	) {
		this.maxRecoveryAttempts = this.readPositiveEnv('AUDIO_MAX_RECOVERY_ATTEMPTS', 3);
		this.recoveryRetryDelayMs = this.readPositiveEnv('AUDIO_RECOVERY_RETRY_DELAY_MS', 60_000);
		this.retryScanIntervalMs = this.readPositiveEnv('AUDIO_RETRY_SCAN_INTERVAL_MS', 30_000);
	}
	private retryTimer: ReturnType<typeof setInterval> | null = null;
	private retryScanRunning = false;
	private readonly maxRecoveryAttempts: number;
	private readonly recoveryRetryDelayMs: number;
	private readonly retryScanIntervalMs: number;

	private readPositiveEnv(name: string, fallback: number): number {
		const raw = this.configService.get<string>(name);

		if (raw === undefined || raw.trim() === '') {
			return fallback;
		}

		const value = Number(raw);

		return Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}

	async resolveSceneVoice(sceneId: number) {
		const scene = await this.prisma.audioScene.findUnique({
			where: { id: sceneId },
			include: {
				character: true
			}
		});

		if (!scene) {
			throw new NotFoundException('Scene not found');
		}

		// Scene override ko first priority
		const voiceId = scene.voiceOverrideId ?? scene.character?.voiceId;

		if (!voiceId) {
			throw new BadRequestException(`No voice assigned to scene ${sceneId}`);
		}

		const voice = await this.prisma.voice.findUnique({
			where: { id: voiceId }
		});

		if (!voice || !voice.isActive) {
			throw new BadRequestException(`Voice ${voiceId} is unavailable or inactive`);
		}

		return {
			scene,
			voice,
			mapping: { provider: voice.provider, providerVoiceId: voice.providerVoiceId, model: voice.model }
		};
	}

	async generateSceneAudio(
		sceneId: number,
		textSnapshot?: string,
		voiceIdSnapshot?: number | null,
		settingsSnapshot?: unknown,
		jobItemId?: number,
		owner?: { jobId: number; startedAt: Date }
	) {
		if (jobItemId) {
			const existing = await this.prisma.sceneAudio.findUnique({ where: { jobItemId } });
			if (existing)
				return {
					id: existing.id,
					sceneId: existing.sceneId,
					filePath: existing.filePath,
					durationMs: existing.durationMs
				};
		}
		const scene = await this.prisma.audioScene.findUnique({
			where: { id: sceneId },
			include: { character: true, story: { select: { userId: true } } }
		});

		if (!scene) {
			throw new NotFoundException('Scene not found');
		}

		const voiceId = voiceIdSnapshot ?? scene.voiceOverrideId ?? scene.character?.voiceId;

		if (!voiceId) {
			throw new BadRequestException(`No voice assigned to scene ${sceneId}`);
		}

		const voice = await this.prisma.voice.findUnique({
			where: { id: voiceId }
		});

		if (!voice || !voice.isActive) {
			throw new BadRequestException(`Voice ${voiceId} unavailable or inactive`);
		}

		const saved =
			settingsSnapshot && typeof settingsSnapshot === 'object' && !Array.isArray(settingsSnapshot)
				? (settingsSnapshot as Record<string, unknown>)
				: null;

		const mapping =
			saved &&
			typeof saved.provider === 'string' &&
			typeof saved.providerVoiceId === 'string' &&
			typeof saved.model === 'string'
				? {
						provider: saved.provider,
						providerVoiceId: saved.providerVoiceId,
						model: saved.model,
						settings: saved.settings ?? null
					}
				: {
						provider: voice.provider,
						providerVoiceId: voice.providerVoiceId,
						model: voice.model,
						settings: null
					};
		const generationText = textSnapshot ?? scene.text;
		if (!generationText.trim()) {
			throw new BadRequestException('Scene text is empty');
		}

		if (!['GOOGLE', 'GEMINI'].includes(mapping.provider?.trim().toUpperCase() ?? '')) {
			throw new BadRequestException(`Unsupported TTS provider: ${mapping.provider}`);
		}

		const promptOptions = {
			text: generationText,
			speaker: scene.speakerName ?? scene.character?.name,
			style: scene.style,
			emotion: scene.emotion,
			languageLabel: scene.language
		};

		const assertOwner = async () => {
			if (
				owner &&
				!(await this.prisma.audioGenerationJob.findFirst({
					where: { id: owner.jobId, status: 'PROCESSING', started_at: owner.startedAt },
					select: { id: true }
				}))
			)
				throw new Error('Generation ownership expired');
		};
		const prompt = buildStylePrompt(promptOptions);

		let wavBuffer: Buffer;

		try {
			// First attempt: original style and emotion
			await assertOwner();
			wavBuffer = await this.geminiTtsService.generateSpeech(prompt, mapping.providerVoiceId, mapping.model, {
				userId: scene.story.userId
			});
		} catch (error) {
			const errorType = classifyGeminiTtsError(error);

			if (!shouldRetryWithNeutralPrompt(error)) {
				throw error;
			}

			console.warn(`Scene ${sceneId}: Gemini TTS ${errorType}. Retrying with neutral prompt.`);

			await assertOwner();
			const fallbackPrompt = buildStylePrompt({
				...promptOptions,
				neutralFallback: true
			});

			wavBuffer = await this.geminiTtsService.generateSpeech(
				fallbackPrompt,
				mapping.providerVoiceId,
				mapping.model,
				{ userId: scene.story.userId }
			);

			console.log(`Scene ${sceneId}: Neutral fallback succeeded.`);
		}

		await assertOwner();
		const filename = `${scene.id}-${randomUUID()}.wav`;

		const storageKey = `audio-stories/${scene.storyId}/${filename}`;

		const filePath = await this.storageService.upload({
			key: storageKey,
			buffer: wavBuffer,
			contentType: 'audio/wav'
		});

		const audio = await this.prisma.$transaction(async tx => {
			if (owner) await tx.$queryRaw`SELECT id FROM "AudioGenerationJob" WHERE id = ${owner.jobId} FOR UPDATE`;
			if (
				owner &&
				!(await tx.audioGenerationJob.findFirst({
					where: { id: owner.jobId, status: 'PROCESSING', started_at: owner.startedAt },
					select: { id: true }
				}))
			)
				throw new Error('Generation ownership expired');
			return tx.sceneAudio.create({
				data: {
					sceneId: scene.id,
					jobItemId,
					voiceId: voice.id,
					provider: mapping.provider,
					providerVoiceId: mapping.providerVoiceId,
					model: mapping.model,
					textSnapshot: generationText,
					settingsSnapshot: { revision: sceneAudioRevision(scene, { id: voice.id, ...mapping }) },
					filePath: filePath,
					format: 'wav',
					mimeType: 'audio/wav',
					fileSizeBytes: BigInt(wavBuffer.length),
					durationMs: Math.round(((wavBuffer.length - 44) / (24000 * 2)) * 1000)
				}
			});
		});

		return {
			id: audio.id,
			sceneId: audio.sceneId,
			filePath: audio.filePath,
			durationMs: audio.durationMs
		};
	}

	private validateSceneVoice(scene: {
		text: string;
		voiceOverride?: { isActive: boolean; provider: string; providerVoiceId: string; model: string } | null;
		character?: {
			voice?: { isActive: boolean; provider: string; providerVoiceId: string; model: string } | null;
		} | null;
	}) {
		const voice = scene.voiceOverride ?? scene.character?.voice;
		if (!scene.text.trim()) throw new BadRequestException('Scene text is empty');
		if (
			!voice?.isActive ||
			!['GOOGLE', 'GEMINI'].includes(voice.provider.trim().toUpperCase()) ||
			!voice.providerVoiceId ||
			!voice.model
		) {
			throw new BadRequestException('Assign an active, supported voice to every scene before generating audio');
		}
	}

	async cancelGenerationJob(jobId: number, userId: number) {
		const owned = await this.prisma.audioGenerationJob.findFirst({
			where: { id: jobId, userId },
			select: { storyId: true }
		});
		if (!owned) throw new NotFoundException('Audio generation job not found');
		await withStoryLock(this.prisma, owned.storyId, async tx => {
			await tx.$queryRaw`SELECT id FROM "AudioGenerationJob" WHERE id = ${jobId} FOR UPDATE`;
			const job = await tx.audioGenerationJob.findFirst({ where: { id: jobId, userId } });
			if (!job || !['PENDING', 'PROCESSING', 'WAITING'].includes(job.status)) return;
			const items = await tx.audioGenerationJobItem.findMany({ where: { jobId }, include: { audio: true } });
			// A scene whose audio committed just before cancellation remains completed.
			for (const item of items) {
				if (!['PENDING', 'PROCESSING', 'WAITING'].includes(item.status)) continue;
				await tx.audioGenerationJobItem.update({
					where: { id: item.id },
					data: {
						status: item.audio ? 'COMPLETED' : 'CANCELLED',
						error: null,
						nextRetryAt: null,
						completed_at: new Date()
					}
				});
			}
			const completedScenes = await tx.audioGenerationJobItem.count({ where: { jobId, status: 'COMPLETED' } });
			const failedScenes = await tx.audioGenerationJobItem.count({ where: { jobId, status: 'FAILED' } });
			await tx.audioGenerationJob.update({
				where: { id: jobId },
				data: { status: 'CANCELLED', completedScenes, failedScenes, completed_at: new Date() }
			});
		});
		return this.getGenerationJob(jobId, userId);
	}

	async getLatestStoryJob(storyId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({ where: { id: storyId, userId }, select: { id: true } });
		if (!story) throw new NotFoundException('Audio story not found');
		const active = await this.prisma.audioGenerationJob.findFirst({
			where: { storyId, userId, status: { in: ['PENDING', 'PROCESSING', 'WAITING'] } },
			orderBy: { id: 'desc' }
		});
		const latest =
			active ??
			(await this.prisma.audioGenerationJob.findFirst({ where: { storyId, userId }, orderBy: { id: 'desc' } }));
		return latest ? this.getGenerationJob(latest.id, userId) : null;
	}

	async createGenerationJob(storyId: number, userId: number) {
		return withStoryLock(this.prisma, storyId, async tx => {
			const story = await tx.audioStory.findFirst({
				where: {
					id: storyId,
					userId
				},
				include: {
					scenes: {
						where: { sceneOrder: { gt: 0 } },
						orderBy: { sceneOrder: 'asc' },
						include: {
							character: { include: { voice: true } },
							voiceOverride: true
						}
					}
				}
			});

			if (!story) {
				throw new NotFoundException('Audio story not found');
			}

			await assertNoActiveJob(tx, storyId);
			if (
				story.status.startsWith('SINGLE_') ||
				story.analysisStatus !== 'COMPLETED' ||
				!(story.analysisResult as { validation?: { valid?: boolean } } | null)?.validation?.valid
			)
				throw new BadRequestException('Complete story analysis before generating audio');
			for (const scene of story.scenes) this.validateSceneVoice(scene);

			if (story.scenes.length === 0) {
				throw new BadRequestException('Story has no scenes');
			}

			const job = await tx.audioGenerationJob.create({
				data: {
					storyId,
					userId,
					totalScenes: story.scenes.length,
					items: {
						create: story.scenes.map(scene => ({
							textSnapshot: scene.text,
							voiceIdSnapshot: scene.voiceOverrideId ?? scene.character?.voiceId ?? null,
							settingsSnapshot: (() => {
								const mapping = scene.voiceOverride ?? scene.character?.voice;

								if (!mapping) return undefined;

								return {
									provider: mapping.provider,
									providerVoiceId: mapping.providerVoiceId,
									model: mapping.model,
									settings: null
								};
							})(),

							scene: {
								connect: {
									id_storyId: {
										id: scene.id,
										storyId
									}
								}
							}
						}))
					}
				},
				include: {
					items: true
				}
			});

			return {
				id: job.id,
				storyId: job.storyId,
				status: job.status,
				totalScenes: job.totalScenes,
				completedScenes: job.completedScenes,
				failedScenes: job.failedScenes
			};
		});
	}

	async createSingleSceneJob(storyId: number, sceneId: number, userId: number) {
		return withStoryLock(this.prisma, storyId, async tx => {
			const story = await tx.audioStory.findFirst({
				where: {
					id: storyId,
					userId
				},
				select: {
					id: true,
					analysisStatus: true,
					status: true,
					scenes: {
						where: { id: sceneId, sceneOrder: { gt: 0 } },
						select: {
							id: true,
							text: true,
							voiceOverrideId: true,
							character: {
								select: {
									voiceId: true,
									voice: true
								}
							},
							voiceOverride: true
						}
					}
				}
			});

			if (!story || story.scenes.length === 0) {
				throw new NotFoundException('Scene not found');
			}

			await assertNoActiveJob(tx, storyId);
			if (story.status.startsWith('SINGLE_') || story.analysisStatus !== 'COMPLETED')
				throw new BadRequestException('Complete story analysis before generating audio');
			const scene = story.scenes[0];
			this.validateSceneVoice(scene);

			const voiceId = scene.voiceOverrideId ?? scene.character?.voiceId ?? null;

			const mapping = scene.voiceOverride ?? scene.character?.voice;

			const job = await tx.audioGenerationJob.create({
				data: {
					storyId,
					userId,
					totalScenes: 1,
					items: {
						create: [
							{
								textSnapshot: scene.text,
								voiceIdSnapshot: voiceId,
								...(mapping
									? {
											settingsSnapshot: {
												provider: mapping.provider,
												providerVoiceId: mapping.providerVoiceId,
												model: mapping.model,
												settings: null
											}
										}
									: {}),
								scene: {
									connect: {
										id_storyId: {
											id: scene.id,
											storyId
										}
									}
								}
							}
						]
					}
				}
			});

			return {
				id: job.id,
				storyId: job.storyId,
				status: job.status,
				totalScenes: job.totalScenes,
				completedScenes: job.completedScenes,
				failedScenes: job.failedScenes
			};
		});
	}

	async processGenerationJob(jobId: number) {
		const startedAt = new Date();
		const ownsJob = async () =>
			!!(await this.prisma.audioGenerationJob.findFirst({
				where: { id: jobId, status: 'PROCESSING', started_at: startedAt },
				select: { id: true }
			}));
		const claimed = await this.prisma.audioGenerationJob.updateMany({
			where: {
				id: jobId,
				status: { in: ['PENDING', 'WAITING'] }
			},
			data: {
				status: 'PROCESSING',
				started_at: startedAt,
				completed_at: null
			}
		});

		if (claimed.count !== 1) {
			return;
		}

		const heartbeat = setInterval(() => {
			void this.prisma.audioGenerationJob
				.updateMany({
					where: { id: jobId, status: 'PROCESSING', started_at: startedAt },
					data: { updated_at: new Date() }
				})
				.catch(error => console.error('Audio job heartbeat failed', error));
		}, 30_000);
		heartbeat.unref();
		try {
			const job = await this.prisma.audioGenerationJob.findUnique({
				where: { id: jobId, status: 'PROCESSING', started_at: startedAt },
				include: {
					items: { orderBy: { id: 'asc' } }
				}
			});

			if (!job) {
				throw new NotFoundException('Audio generation job not found');
			}

			for (const item of job.items) {
				if (!(await ownsJob())) return;
				if (item.status === 'COMPLETED' || item.status === 'FAILED') {
					continue;
				}

				if (item.status === 'WAITING') {
					const now = new Date();

					if (!item.nextRetryAt || item.nextRetryAt > now) {
						await this.updateJobProgress(jobId);

						await this.prisma.audioGenerationJob.updateMany({
							where: { id: jobId, status: 'PROCESSING', started_at: startedAt },
							data: { status: 'WAITING' }
						});

						return;
					}
				}

				const itemClaim = await this.prisma.audioGenerationJobItem.updateMany({
					where: {
						id: item.id,
						job: { id: jobId, status: 'PROCESSING', started_at: startedAt },
						status: { in: ['PENDING', 'WAITING'] }
					},
					data: {
						status: 'PROCESSING',
						attempts: { increment: 1 },
						started_at: new Date(),
						nextRetryAt: null,
						completed_at: null
					}
				});

				if (itemClaim.count !== 1) {
					continue;
				}

				try {
					const audio = await this.generateSceneAudio(
						item.sceneId,
						item.textSnapshot ?? undefined,
						item.voiceIdSnapshot,
						item.settingsSnapshot,
						item.id,
						{ jobId, startedAt }
					);
					if (!(await ownsJob())) return;
					await this.prisma.audioGenerationJobItem.updateMany({
						where: { id: item.id, job: { id: jobId, status: 'PROCESSING', started_at: startedAt } },
						data: {
							status: 'COMPLETED',
							error: null,
							nextRetryAt: null,
							completed_at: new Date()
						}
					});
				} catch (error: unknown) {
					if (!(await ownsJob())) return;
					if (error instanceof GeminiKeysUnavailableError || error instanceof AiCapacityError) {
						const nextRetryAt = error.nextRetryAt;

						if (!nextRetryAt) {
							throw new Error('Gemini keys unavailable without a retry time');
						}

						// Avoid immediate retry loops.
						const safeRetryAt = new Date(Math.max(nextRetryAt.getTime(), Date.now() + 1000));

						await this.prisma.audioGenerationJobItem.updateMany({
							where: { id: item.id, job: { id: jobId, status: 'PROCESSING', started_at: startedAt } },
							data: {
								status: 'WAITING',
								error: safeAiError(error),
								lastErrorAt: new Date(),
								nextRetryAt: safeRetryAt,
								attempts: { decrement: 1 }
							}
						});

						await this.updateJobProgress(jobId);

						await this.prisma.audioGenerationJob.updateMany({
							where: { id: jobId, status: 'PROCESSING', started_at: startedAt },
							data: { status: 'WAITING' }
						});

						return;
					}

					const transient =
						['NETWORK', 'NO_AUDIO'].includes(classifyGeminiTtsError(error)) ||
						/\b(?:500|502|503|504)\b/.test(error instanceof Error ? error.message : '');
					if (transient && item.attempts + 1 < this.maxRecoveryAttempts) {
						await this.prisma.audioGenerationJobItem.updateMany({
							where: { id: item.id, job: { id: jobId, status: 'PROCESSING', started_at: startedAt } },
							data: {
								status: 'WAITING',
								error: safeAiError(error),
								lastErrorAt: new Date(),
								nextRetryAt: new Date(Date.now() + this.recoveryRetryDelayMs * 2 ** item.attempts)
							}
						});
						await this.updateJobProgress(jobId);
						await this.prisma.audioGenerationJob.updateMany({
							where: { id: jobId, status: 'PROCESSING', started_at: startedAt },
							data: { status: 'WAITING' }
						});
						return;
					}

					await this.prisma.audioGenerationJobItem.updateMany({
						where: { id: item.id, job: { id: jobId, status: 'PROCESSING', started_at: startedAt } },
						data: {
							status: 'FAILED',
							error: safeAiError(error),
							lastErrorAt: new Date(),
							completed_at: new Date()
						}
					});
				}

				await this.updateJobProgress(jobId);
			}

			const progress = await this.updateJobProgress(jobId);

			const finalStatus = progress.failed === 0 ? 'COMPLETED' : progress.completed === 0 ? 'FAILED' : 'PARTIAL';

			return this.prisma.audioGenerationJob.updateMany({
				where: { id: jobId, status: 'PROCESSING', started_at: startedAt },
				data: {
					status: finalStatus,
					completedScenes: progress.completed,
					failedScenes: progress.failed,
					completed_at: new Date()
				}
			});
		} finally {
			clearInterval(heartbeat);
		}
	}

	async getGenerationJob(jobId: number, userId: number) {
		const job = await this.prisma.audioGenerationJob.findFirst({
			where: {
				id: jobId,
				userId
			},
			include: {
				items: {
					orderBy: { id: 'asc' },
					select: {
						id: true,
						sceneId: true,
						status: true,
						attempts: true,
						error: true,
						nextRetryAt: true,
						audio: {
							select: {
								id: true,
								filePath: true,
								durationMs: true,
								format: true
							}
						}
					}
				}
			}
		});

		if (!job) {
			throw new NotFoundException('Audio generation job not found');
		}

		return {
			id: job.id,
			storyId: job.storyId,
			status: job.status,
			totalScenes: job.totalScenes,
			completedScenes: job.completedScenes,
			failedScenes: job.failedScenes,
			items: job.items
		};
	}

	startGenerationInBackground(jobId: number): void {
		setImmediate(() => {
			void this.processGenerationJob(jobId).catch(error => {
				console.error(`Audio generation job ${jobId} interrupted; stale-job recovery will retry it:`, error);
			});
		});
	}

	async recoverInterruptedJobs() {
		const interruptedJobs = await this.prisma.audioGenerationJob.findMany({
			where: { status: 'PROCESSING', updated_at: { lt: new Date(Date.now() - 5 * 60_000) } },
			select: {
				id: true,
				items: {
					where: { status: 'PROCESSING' },
					select: {
						id: true,
						attempts: true
					}
				}
			}
		});

		for (const job of interruptedJobs) {
			await this.prisma.$transaction(async tx => {
				const claimed = await tx.audioGenerationJob.updateMany({
					where: { id: job.id, status: 'PROCESSING', updated_at: { lt: new Date(Date.now() - 5 * 60_000) } },
					data: { status: 'WAITING' }
				});
				if (claimed.count !== 1) return;
				for (const item of job.items) {
					const exhausted = item.attempts >= this.maxRecoveryAttempts;

					await tx.audioGenerationJobItem.update({
						where: { id: item.id },
						data: exhausted
							? {
									status: 'FAILED',
									error: 'Recovery retry limit exceeded',
									completed_at: new Date(),
									nextRetryAt: null
								}
							: {
									status: 'WAITING',
									error: 'Generation interrupted; retry scheduled',
									nextRetryAt: new Date(Date.now() + this.recoveryRetryDelayMs)
								}
					});
				}

				await tx.audioGenerationJob.update({
					where: { id: job.id },
					data: {
						status: 'WAITING',
						completed_at: null
					}
				});
			});
			await this.finalizeJobIfFinished(job.id);
		}

		await this.prisma.audioGenerationJobItem.updateMany({
			where: {
				status: 'WAITING',
				nextRetryAt: null,
				job: {
					status: 'WAITING'
				}
			},
			data: {
				nextRetryAt: new Date()
			}
		});

		const waitingJobs = await this.prisma.audioGenerationJob.findMany({
			where: {
				status: 'WAITING',
				items: {
					none: {
						status: {
							in: ['PENDING', 'PROCESSING', 'WAITING']
						}
					}
				}
			},
			select: { id: true }
		});

		for (const job of waitingJobs) {
			await this.finalizeJobIfFinished(job.id);
		}

		return interruptedJobs.length;
	}

	async onModuleInit() {
		const recovered = await this.recoverInterruptedJobs();

		if (recovered > 0) {
			console.log(`Recovered ${recovered} interrupted audio generation jobs`);
		}
		await this.resumeWaitingJobs();

		this.retryTimer = setInterval(() => {
			void this.resumeWaitingJobs().catch((error: unknown) => {
				console.error('Failed to resume waiting audio jobs:', error);
			});
		}, this.retryScanIntervalMs);
	}

	onModuleDestroy() {
		if (this.retryTimer) {
			clearInterval(this.retryTimer);
			this.retryTimer = null;
		}
	}

	async retryFailedJob(jobId: number, userId: number) {
		const job = await this.prisma.audioGenerationJob.findFirst({
			where: {
				id: jobId,
				userId
			},
			include: {
				items: true
			}
		});

		if (!job) {
			throw new NotFoundException('Audio generation job not found');
		}

		return withStoryLock(this.prisma, job.storyId, async tx => {
			await assertNoActiveJob(tx, job.storyId);
			const story = await tx.audioStory.findFirst({ where: { id: job.storyId, userId } });
			if (story?.analysisStatus !== 'COMPLETED')
				throw new BadRequestException('Complete story analysis before retrying');
			if (!['FAILED', 'PARTIAL'].includes(job.status)) {
				throw new BadRequestException('Only FAILED or PARTIAL jobs can be retried');
			}

			const failedItems = job.items.filter(item => item.status === 'FAILED');

			if (failedItems.length === 0) {
				throw new BadRequestException('No failed scenes to retry');
			}

			for (const item of failedItems) {
				const scene = await tx.audioScene.findFirst({
					where: { id: item.sceneId, storyId: job.storyId, sceneOrder: { gt: 0 } },
					include: { character: { include: { voice: true } }, voiceOverride: true }
				});
				if (
					!scene ||
					scene.text !== item.textSnapshot ||
					(scene.voiceOverrideId ?? scene.character?.voiceId) !== item.voiceIdSnapshot
				)
					throw new BadRequestException(
						'Script or voice has changed. Generate new audio instead of retrying this job.'
					);
				this.validateSceneVoice(scene);
				const mapping = scene.voiceOverride ?? scene.character?.voice;
				const snapshot = item.settingsSnapshot as {
					provider?: string;
					providerVoiceId?: string;
					model?: string;
				} | null;
				if (
					snapshot &&
					mapping &&
					(snapshot.provider !== mapping.provider ||
						snapshot.providerVoiceId !== mapping.providerVoiceId ||
						snapshot.model !== mapping.model)
				)
					throw new BadRequestException(
						'Voice settings have changed. Generate new audio instead of retrying this job.'
					);
			}

			// Create a new job for failed scenes only.
			// Keep the original job and its completed audio unchanged.
			const retryJob = await tx.audioGenerationJob.create({
				data: {
					storyId: job.storyId,
					userId,
					totalScenes: failedItems.length,
					items: {
						create: failedItems.map(item => ({
							textSnapshot: item.textSnapshot,
							voiceIdSnapshot: item.voiceIdSnapshot,

							...(item.settingsSnapshot != null ? { settingsSnapshot: item.settingsSnapshot } : {}),

							scene: {
								connect: {
									id_storyId: {
										id: item.sceneId,
										storyId: job.storyId
									}
								}
							}
						}))
					}
				}
			});

			return {
				id: retryJob.id,
				storyId: retryJob.storyId,
				status: retryJob.status,
				totalScenes: retryJob.totalScenes,
				completedScenes: retryJob.completedScenes,
				failedScenes: retryJob.failedScenes
			};
		});
	}

	async getAudioFile(audioId: number, userId: number) {
		const audio = await this.prisma.sceneAudio.findFirst({
			where: {
				id: audioId,
				scene: {
					story: { userId }
				}
			},
			select: {
				id: true,
				filePath: true,
				mimeType: true,
				scene: { select: { sceneOrder: true, title: true, text: true } }
			}
		});

		if (!audio) {
			throw new NotFoundException('Audio not found');
		}

		return {
			filePath: audio.filePath,
			mimeType: audio.mimeType || 'audio/wav',
			filename: sceneDownloadFilename(audio.scene.sceneOrder, audio.scene.title, audio.scene.text)
		};
	}

	async getStoryAudioHistory(storyId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: {
				id: storyId,
				userId
			},
			select: {
				id: true,
				title: true,
				analysisStatus: true,
				scenes: {
					where: { sceneOrder: { gt: 0 } },
					orderBy: {
						sceneOrder: 'asc'
					},
					select: {
						id: true,
						sceneOrder: true,
						title: true,
						speakerName: true,
						text: true,
						style: true,
						emotion: true,
						language: true,
						updated_at: true,
						character: { include: { voice: true } },
						voiceOverride: true,
						jobItems: {
							orderBy: { id: 'desc' },
							take: 1,
							select: {
								id: true,
								sceneId: true,
								status: true,
								attempts: true,
								error: true,
								nextRetryAt: true
							}
						},
						audios: {
							orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
							select: {
								id: true,
								sceneId: true,
								voiceId: true,
								provider: true,
								providerVoiceId: true,
								model: true,
								settingsSnapshot: true,
								format: true,
								durationMs: true,
								created_at: true,
								textSnapshot: true,
								voice: {
									select: {
										id: true,
										name: true
									}
								}
							}
						}
					}
				}
			}
		});

		if (!story) {
			throw new NotFoundException('Audio story not found');
		}

		const currentScenes = (story.analysisStatus === 'COMPLETED' ? story.scenes : []).map(scene => ({
			...scene,
			audios: scene.audios.filter(audio =>
				isCurrentSceneAudio(scene, scene.voiceOverride ?? scene.character?.voice ?? null, audio)
			)
		}));

		return {
			storyId: story.id,
			title: story.title,
			totalScenes: currentScenes.length,
			generatedScenes: currentScenes.filter(scene => scene.audios.length > 0).length,
			scenes: currentScenes.map(scene => ({
				id: scene.id,
				sceneOrder: scene.sceneOrder,
				title: scene.title,
				speakerName: scene.speakerName,
				text: scene.text,
				assignedVoice: (() => {
					const voice = scene.voiceOverride ?? scene.character?.voice;
					return voice ? { id: voice.id, name: voice.name } : null;
				})(),
				downloadFilename: sceneDownloadFilename(scene.sceneOrder, scene.title, scene.text),
				latestAudio: scene.audios[0] ?? null,
				lastGeneration: scene.jobItems[0] ?? null,
				audioVersions: scene.audios
			}))
		};
	}

	async exportStoryWav(storyId: number, userId: number) {
		const history = await this.getStoryAudioHistory(storyId, userId);
		const story = {
			...history,
			id: history.storyId,
			scenes: history.scenes.map(scene => ({ ...scene, audios: scene.latestAudio ? [scene.latestAudio] : [] }))
		};

		if (!story) {
			throw new NotFoundException('Audio story not found');
		}

		if (story.scenes.length === 0) {
			throw new BadRequestException('Story has no scenes');
		}

		const missingScenes = story.scenes.filter(scene => scene.audios.length === 0);

		if (missingScenes.length > 0) {
			throw new BadRequestException(`Audio missing for ${missingScenes.length} scene(s)`);
		}

		const buffers: Buffer[] = [];

		for (const scene of story.scenes) {
			const audioId = scene.audios[0].id;

			// Ownership verification
			const audioFile = await this.getAudioFile(audioId, userId);

			// Read from Local or Supabase Storage
			const storedFile = await this.storageService.getFile(audioFile.filePath);

			const audioBuffer = await this.streamToBuffer(storedFile.stream);

			buffers.push(audioBuffer);
		}

		const mergedBuffer = mergeWavBuffers(buffers, 300);

		const byteRate = mergedBuffer.readUInt32LE(28);
		const dataSize = mergedBuffer.readUInt32LE(40);

		const durationMs = Math.round((dataSize / byteRate) * 1000);

		const filename = `story-${storyId}-${randomUUID()}.wav`;

		const storageKey = `audio-stories/${storyId}/exports/${filename}`;

		const filePath = await this.storageService.upload({
			key: storageKey,
			buffer: mergedBuffer,
			contentType: 'audio/wav'
		});

		const asset = await this.prisma.audioAsset.create({
			data: {
				storyId,
				type: 'COMBINED_AUDIO',
				filePath: filePath,
				format: 'wav',
				mimeType: 'audio/wav',
				fileSizeBytes: BigInt(mergedBuffer.length),
				durationMs: durationMs
			}
		});

		return {
			id: asset.id,
			storyId,
			format: asset.format,
			durationMs: asset.durationMs,
			filename
		};
	}

	async getExportedAudioFile(assetId: number, userId: number) {
		const asset = await this.prisma.audioAsset.findFirst({
			where: {
				id: assetId,
				story: {
					userId
				},
				type: 'COMBINED_AUDIO'
			},
			select: {
				id: true,
				storyId: true,
				filePath: true,
				mimeType: true
			}
		});

		if (!asset) {
			throw new NotFoundException('Exported audio not found');
		}

		// Verify that this asset belongs to its story's export directory.
		const expectedPrefix = `audio-stories/${asset.storyId}/exports/`;

		const normalizedPath = asset.filePath.replace(/\\/g, '/');

		const storageKey = normalizedPath.replace(/^(local|supabase):\/\//, '').replace(/^uploads\//, '');

		if (
			!storageKey.startsWith(expectedPrefix) ||
			!storageKey.slice(expectedPrefix.length) ||
			storageKey.split('/').includes('..')
		) {
			throw new NotFoundException('Exported audio file not found');
		}

		const metadata = await this.storageService.getMetadata(asset.filePath);

		return {
			filePath: asset.filePath,
			fileSize: metadata.size,
			mimeType: asset.mimeType || metadata.contentType,
			filename: `story-${asset.storyId}-export-${asset.id}.wav`
		};
	}

	async downloadStoryAudioZip(storyId: number, userId: number) {
		const history = await this.getStoryAudioHistory(storyId, userId);
		const story = {
			...history,
			id: history.storyId,
			scenes: history.scenes.map(scene => ({ ...scene, audios: scene.latestAudio ? [scene.latestAudio] : [] }))
		};

		if (!story) {
			throw new NotFoundException('Audio story not found');
		}

		if (story.scenes.length === 0) {
			throw new BadRequestException('Story has no scenes');
		}

		const missingScenes = story.scenes.filter(scene => scene.audios.length === 0);

		if (missingScenes.length > 0) {
			throw new BadRequestException(`Audio missing for ${missingScenes.length} scene(s)`);
		}

		// Verify ownership and file existence before ZIP streaming.
		const files: { filePath: string; name: string }[] = [];

		for (const scene of story.scenes) {
			const audioFile = await this.getAudioFile(scene.audios[0].id, userId);

			await this.storageService.getMetadata(audioFile.filePath);

			files.push({
				filePath: audioFile.filePath,
				name: scene.downloadFilename
			});
		}

		const stream = new PassThrough();

		const archive = new ZipArchive({
			zlib: { level: 6 }
		});

		archive.on('warning', (error: Error) => {
			stream.destroy(error);
		});

		archive.on('error', (error: Error) => {
			stream.destroy(error);
		});

		archive.pipe(stream);

		// Prepare archive asynchronously so the HTTP stream can start.
		void (async () => {
			for (const file of files) {
				if (stream.destroyed) {
					break;
				}

				const storedFile = await this.storageService.getFile(file.filePath);

				storedFile.stream.on('error', (error: Error) => {
					archive.abort();
					stream.destroy(error);
				});

				archive.append(storedFile.stream, {
					name: file.name
				});
			}

			if (!stream.destroyed) {
				await archive.finalize();
			}
		})().catch((error: unknown) => {
			archive.abort();
			stream.destroy(error instanceof Error ? error : new Error(String(error)));
		});

		return {
			stream,
			filename: `story-${storyId}-audio.zip`
		};
	}

	private async updateJobProgress(jobId: number) {
		const [completed, failed] = await Promise.all([
			this.prisma.audioGenerationJobItem.count({
				where: { jobId, status: 'COMPLETED' }
			}),
			this.prisma.audioGenerationJobItem.count({
				where: { jobId, status: 'FAILED' }
			})
		]);

		await this.prisma.audioGenerationJob.updateMany({
			where: { id: jobId, status: { not: 'CANCELLED' } },
			data: {
				completedScenes: completed,
				failedScenes: failed
			}
		});

		return { completed, failed };
	}

	private async resumeWaitingJobs(): Promise<void> {
		if (this.retryScanRunning) {
			return;
		}

		this.retryScanRunning = true;

		try {
			await this.recoverInterruptedJobs();
			const pending = await this.prisma.audioGenerationJob.findMany({
				where: { status: 'PENDING' },
				select: { id: true }
			});
			for (const job of pending) this.startGenerationInBackground(job.id);
			const now = new Date();

			const jobs = await this.prisma.audioGenerationJob.findMany({
				where: {
					status: 'WAITING',
					NOT: {
						items: {
							some: {
								status: 'WAITING',
								nextRetryAt: { gt: now }
							}
						}
					},
					items: {
						some: {
							OR: [
								{
									status: 'WAITING',
									nextRetryAt: { lte: now }
								},
								{
									status: 'PENDING'
								}
							]
						}
					}
				},
				select: {
					id: true
				}
			});

			for (const job of jobs) {
				this.startGenerationInBackground(job.id);
			}
		} catch (error: unknown) {
			console.error('Failed to resume waiting audio jobs:', error);
		} finally {
			this.retryScanRunning = false;
		}
	}

	private async finalizeJobIfFinished(jobId: number): Promise<boolean> {
		const items = await this.prisma.audioGenerationJobItem.findMany({
			where: { jobId },
			select: { status: true }
		});

		if (items.length === 0) {
			return false;
		}

		const completed = items.filter(item => item.status === 'COMPLETED').length;

		const failed = items.filter(item => item.status === 'FAILED').length;

		// Pending, Processing ya Waiting scenes bache hain.
		if (completed + failed !== items.length) {
			return false;
		}

		const finalStatus = failed === 0 ? 'COMPLETED' : completed === 0 ? 'FAILED' : 'PARTIAL';

		await this.prisma.audioGenerationJob.updateMany({
			where: {
				id: jobId,
				status: 'WAITING'
			},
			data: {
				status: finalStatus,
				completedScenes: completed,
				failedScenes: failed,
				completed_at: new Date()
			}
		});

		return true;
	}

	private async streamToBuffer(stream: Readable): Promise<Buffer> {
		const chunks: Buffer[] = [];

		for await (const chunk of stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}

		return Buffer.concat(chunks);
	}
}
