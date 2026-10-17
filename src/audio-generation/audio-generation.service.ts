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
@Injectable()
export class audioGenerationService implements OnModuleInit, OnModuleDestroy {
	constructor(
		private readonly prisma: PrismaService,
		private readonly geminiTtsService: GeminiTtsService,
		private readonly configService: ConfigService
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
			where: { id: voiceId },
			include: {
				providerMapping: true
			}
		});

		if (!voice || !voice.isActive) {
			throw new BadRequestException(`Voice ${voiceId} is unavailable or inactive`);
		}

		if (!voice.providerMapping) {
			throw new BadRequestException(`Provider mapping missing for voice ${voiceId}`);
		}

		return {
			scene,
			voice,
			mapping: voice.providerMapping
		};
	}

	async generateSpeech(text: string, voiceName: string, model: string): Promise<Buffer> {
		return this.geminiTtsService.generateSpeech(text, voiceName, model);
	}

	async generateSceneAudio(
		sceneId: number,
		textSnapshot?: string,
		voiceIdSnapshot?: number | null,
		settingsSnapshot?: unknown
	) {
		const scene = await this.prisma.audioScene.findUnique({
			where: { id: sceneId },
			include: { character: true }
		});

		if (!scene) {
			throw new NotFoundException('Scene not found');
		}

		const voiceId = voiceIdSnapshot ?? scene.voiceOverrideId ?? scene.character?.voiceId;

		if (!voiceId) {
			throw new BadRequestException(`No voice assigned to scene ${sceneId}`);
		}

		const voice = await this.prisma.voice.findUnique({
			where: { id: voiceId },
			include: { providerMapping: true }
		});

		if (!voice || !voice.providerMapping) {
			throw new BadRequestException(`Voice ${voiceId} or provider mapping unavailable`);
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
				: voice.providerMapping;
		const generationText = textSnapshot ?? scene.text;

		if (!generationText.trim()) {
			throw new BadRequestException('Scene text is empty');
		}

		if (mapping.provider?.trim().toUpperCase() !== 'GOOGLE') {
			throw new BadRequestException(`Unsupported TTS provider: ${mapping.provider}`);
		}

		const wavBuffer = await this.geminiTtsService.generateSpeech(
			generationText,
			mapping.providerVoiceId,
			mapping.model
		);

		const directory = join(process.cwd(), 'uploads', 'audio-stories', String(scene.storyId));

		await mkdir(directory, { recursive: true });

		const filename = `${scene.id}-${randomUUID()}.wav`;
		const absolutePath = join(directory, filename);

		await writeFile(absolutePath, wavBuffer);

		const relativePath = join('uploads', 'audio-stories', String(scene.storyId), filename);

		const audio = await this.prisma.sceneAudio.create({
			data: {
				sceneId: scene.id,
				voiceId: voice.id,
				provider: mapping.provider,
				providerVoiceId: mapping.providerVoiceId,
				model: mapping.model,
				textSnapshot: generationText,
				settingsSnapshot: mapping.settings ?? undefined,
				filePath: relativePath,
				format: 'wav',
				mimeType: 'audio/wav',
				fileSizeBytes: BigInt(wavBuffer.length),
				durationMs: Math.round(((wavBuffer.length - 44) / (24000 * 2)) * 1000)
			}
		});

		return {
			id: audio.id,
			sceneId: audio.sceneId,
			filePath: audio.filePath,
			durationMs: audio.durationMs
		};
	}

	async createGenerationJob(storyId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: {
				id: storyId,
				userId
			},
			include: {
				scenes: {
					orderBy: { sceneOrder: 'asc' },
					include: {
						character: {
							include: {
								voice: {
									include: { providerMapping: true }
								}
							}
						},
						voiceOverride: {
							include: { providerMapping: true }
						}
					}
				}
			}
		});

		if (!story) {
			throw new NotFoundException('Audio story not found');
		}

		if (story.scenes.length === 0) {
			throw new BadRequestException('Story has no scenes');
		}

		const job = await this.prisma.audioGenerationJob.create({
			data: {
				storyId,
				userId,
				totalScenes: story.scenes.length,
				items: {
					create: story.scenes.map(scene => ({
						textSnapshot: scene.text,
						voiceIdSnapshot: scene.voiceOverrideId ?? scene.character?.voiceId ?? null,
						settingsSnapshot: (() => {
							const mapping = (scene.voiceOverride ?? scene.character?.voice)?.providerMapping;

							if (!mapping) return undefined;

							return {
								provider: mapping.provider,
								providerVoiceId: mapping.providerVoiceId,
								model: mapping.model,
								settings: mapping.settings
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
	}

	async createSingleSceneJob(storyId: number, sceneId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: {
				id: storyId,
				userId
			},
			select: {
				id: true,
				scenes: {
					where: { id: sceneId },
					select: {
						id: true,
						text: true,
						voiceOverrideId: true,
						character: {
							select: {
								voiceId: true,
								voice: {
									select: {
										providerMapping: true
									}
								}
							}
						},
						voiceOverride: {
							select: {
								providerMapping: true
							}
						}
					}
				}
			}
		});

		if (!story || story.scenes.length === 0) {
			throw new NotFoundException('Scene not found');
		}

		const scene = story.scenes[0];

		const voiceId = scene.voiceOverrideId ?? scene.character?.voiceId ?? null;

		const mapping = (scene.voiceOverride ?? scene.character?.voice)?.providerMapping;

		const job = await this.prisma.audioGenerationJob.create({
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
											settings: mapping.settings
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
	}

	async processGenerationJob(jobId: number) {
		const claimed = await this.prisma.audioGenerationJob.updateMany({
			where: {
				id: jobId,
				status: { in: ['PENDING', 'WAITING'] }
			},
			data: {
				status: 'PROCESSING',
				started_at: new Date(),
				completed_at: null
			}
		});

		if (claimed.count !== 1) {
			return;
		}

		const job = await this.prisma.audioGenerationJob.findUnique({
			where: { id: jobId },
			include: {
				items: { orderBy: { id: 'asc' } }
			}
		});

		if (!job) {
			throw new NotFoundException('Audio generation job not found');
		}

		for (const item of job.items) {
			if (item.status === 'COMPLETED' || item.status === 'FAILED') {
				continue;
			}

			if (item.status === 'WAITING') {
				const now = new Date();

				if (!item.nextRetryAt || item.nextRetryAt > now) {
					await this.updateJobProgress(jobId);

					await this.prisma.audioGenerationJob.update({
						where: { id: jobId },
						data: { status: 'WAITING' }
					});

					return;
				}
			}

			const itemClaim = await this.prisma.audioGenerationJobItem.updateMany({
				where: {
					id: item.id,
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
					item.settingsSnapshot
				);
				await this.prisma.audioGenerationJobItem.update({
					where: { id: item.id },
					data: {
						status: 'COMPLETED',
						error: null,
						nextRetryAt: null,
						completed_at: new Date(),
						audio: {
							connect: { id: audio.id }
						}
					}
				});
			} catch (error: unknown) {
				if (error instanceof GeminiKeysUnavailableError) {
					const nextRetryAt = error.nextRetryAt;

					if (!nextRetryAt) {
						throw new Error('Gemini keys unavailable without a retry time');
					}

					// Avoid immediate retry loops.
					const safeRetryAt = new Date(Math.max(nextRetryAt.getTime(), Date.now() + 1000));

					await this.prisma.audioGenerationJobItem.update({
						where: { id: item.id },
						data: {
							status: 'WAITING',
							error: error.message,
							lastErrorAt: new Date(),
							nextRetryAt: safeRetryAt,
							attempts: { decrement: 1 }
						}
					});

					await this.updateJobProgress(jobId);

					await this.prisma.audioGenerationJob.update({
						where: { id: jobId },
						data: { status: 'WAITING' }
					});

					return;
				}

				await this.prisma.audioGenerationJobItem.update({
					where: { id: item.id },
					data: {
						status: 'FAILED',
						error: error instanceof Error ? error.message : 'Unknown audio generation error',
						lastErrorAt: new Date(),
						completed_at: new Date()
					}
				});
			}

			await this.updateJobProgress(jobId);
		}

		const progress = await this.updateJobProgress(jobId);

		const finalStatus = progress.failed === 0 ? 'COMPLETED' : progress.completed === 0 ? 'FAILED' : 'PARTIAL';

		return this.prisma.audioGenerationJob.update({
			where: { id: jobId },
			data: {
				status: finalStatus,
				completedScenes: progress.completed,
				failedScenes: progress.failed,
				completed_at: new Date()
			}
		});
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
			void this.processGenerationJob(jobId).catch(async (error: unknown) => {
				console.error(`Audio generation job ${jobId} failed unexpectedly:`, error);

				try {
					await this.prisma.$transaction(async tx => {
						const processingItems = await tx.audioGenerationJobItem.findMany({
							where: {
								jobId,
								status: 'PROCESSING'
							},
							select: {
								id: true,
								attempts: true
							}
						});

						for (const item of processingItems) {
							const exhausted = item.attempts >= this.maxRecoveryAttempts;

							await tx.audioGenerationJobItem.update({
								where: { id: item.id },
								data: exhausted
									? {
											status: 'FAILED',
											error: 'Recovery retry limit exceeded',
											nextRetryAt: null,
											completed_at: new Date()
										}
									: {
											status: 'WAITING',
											error: 'Unexpected processing interruption',
											nextRetryAt: new Date(Date.now() + this.recoveryRetryDelayMs)
										}
							});
						}

						await tx.audioGenerationJob.updateMany({
							where: {
								id: jobId,
								status: 'PROCESSING'
							},
							data: {
								status: 'WAITING'
							}
						});
					});
					await this.finalizeJobIfFinished(jobId);
				} catch (recoveryError: unknown) {
					console.error(`Failed to recover audio job ${jobId}:`, recoveryError);
				}
			});
		});
	}

	async recoverInterruptedJobs() {
		const interruptedJobs = await this.prisma.audioGenerationJob.findMany({
			where: { status: 'PROCESSING' },
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

		if (!['FAILED', 'PARTIAL'].includes(job.status)) {
			throw new BadRequestException('Only FAILED or PARTIAL jobs can be retried');
		}

		const failedItems = job.items.filter(item => item.status === 'FAILED');

		if (failedItems.length === 0) {
			throw new BadRequestException('No failed scenes to retry');
		}

		// Create a new job for failed scenes only.
		// Keep the original job and its completed audio unchanged.
		const retryJob = await this.prisma.audioGenerationJob.create({
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
				mimeType: true
			}
		});

		if (!audio) {
			throw new NotFoundException('Audio not found');
		}

		const { resolve, relative, isAbsolute } = await import('node:path');
		const { stat } = await import('node:fs/promises');

		const uploadsRoot = resolve(process.cwd(), 'uploads');
		const absolutePath = resolve(process.cwd(), audio.filePath);
		const relativePath = relative(uploadsRoot, absolutePath);

		if (
			relativePath === '..' ||
			relativePath.startsWith(`..${(await import('node:path')).sep}`) ||
			isAbsolute(relativePath)
		) {
			throw new NotFoundException('Audio file not found');
		}

		let fileStat;
		try {
			fileStat = await stat(absolutePath);
		} catch {
			throw new NotFoundException('Audio file not found');
		}

		if (!fileStat.isFile()) {
			throw new NotFoundException('Audio file not found');
		}

		return {
			absolutePath,
			fileSize: fileStat.size,
			mimeType: audio.mimeType || 'audio/wav',
			filename: `${audio.id}.wav`
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
				scenes: {
					orderBy: {
						sceneOrder: 'asc'
					},
					select: {
						id: true,
						sceneOrder: true,
						title: true,
						speakerName: true,
						text: true,
						audios: {
							orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
							select: {
								id: true,
								sceneId: true,
								voiceId: true,
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

		return {
			storyId: story.id,
			title: story.title,
			totalScenes: story.scenes.length,
			generatedScenes: story.scenes.filter(scene => scene.audios.length > 0).length,
			scenes: story.scenes.map(scene => ({
				id: scene.id,
				sceneOrder: scene.sceneOrder,
				title: scene.title,
				speakerName: scene.speakerName,
				text: scene.text,
				latestAudio: scene.audios[0] ?? null,
				audioVersions: scene.audios
			}))
		};
	}

	async exportStoryWav(storyId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: { id: storyId, userId },
			select: {
				id: true,
				scenes: {
					orderBy: { sceneOrder: 'asc' },
					include: {
						character: true
					},
					select: {
						id: true,
						audios: {
							orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
							take: 1,
							select: {
								id: true,
								filePath: true
							}
						}
					}
				}
			}
		});

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

			// Reuse existing ownership and file validation.
			const audioFile = await this.getAudioFile(audioId, userId);

			buffers.push(await readFile(audioFile.absolutePath));
		}

		const mergedBuffer = mergeWavBuffers(buffers, 300);

		const byteRate = mergedBuffer.readUInt32LE(28);
		const dataSize = mergedBuffer.readUInt32LE(40);

		const durationMs = Math.round((dataSize / byteRate) * 1000);

		const directory = resolve(process.cwd(), 'uploads', 'audio-stories', String(storyId), 'exports');

		await mkdir(directory, { recursive: true });

		const filename = `story-${storyId}-${randomUUID()}.wav`;
		const absolutePath = join(directory, filename);

		await writeFile(absolutePath, mergedBuffer);

		const relativePath = join('uploads', 'audio-stories', String(storyId), 'exports', filename);

		const asset = await this.prisma.audioAsset.create({
			data: {
				storyId,
				type: 'COMBINED_AUDIO',
				filePath: relativePath,
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

		const { resolve, relative, isAbsolute, sep } = await import('node:path');

		const { stat } = await import('node:fs/promises');

		const exportsRoot = resolve(process.cwd(), 'uploads', 'audio-stories', String(asset.storyId), 'exports');

		const absolutePath = resolve(process.cwd(), asset.filePath);
		const relativePath = relative(exportsRoot, absolutePath);

		if (
			relativePath === '' ||
			relativePath === '..' ||
			relativePath.startsWith(`..${sep}`) ||
			isAbsolute(relativePath)
		) {
			throw new NotFoundException('Exported audio file not found');
		}

		let fileStat;

		try {
			fileStat = await stat(absolutePath);
		} catch {
			throw new NotFoundException('Exported audio file not found');
		}

		if (!fileStat.isFile()) {
			throw new NotFoundException('Exported audio file not found');
		}

		return {
			absolutePath,
			fileSize: fileStat.size,
			mimeType: asset.mimeType || 'audio/wav',
			filename: `story-${asset.storyId}-export-${asset.id}.wav`
		};
	}

	async downloadStoryAudioZip(storyId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: {
				id: storyId,
				userId
			},
			select: {
				id: true,
				scenes: {
					orderBy: { sceneOrder: 'asc' },
					select: {
						id: true,
						audios: {
							orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
							take: 1,
							select: {
								id: true
							}
						}
					}
				}
			}
		});

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

		// Validate all files before starting the ZIP response.
		const files: { path: string; name: string }[] = [];
		for (const [index, scene] of story.scenes.entries()) {
			const audioFile = await this.getAudioFile(scene.audios[0].id, userId);

			files.push({
				path: audioFile.absolutePath,
				name: `scene-${String(index + 1).padStart(3, '0')}.wav`
			});
		}

		const stream = new PassThrough();

		const archive = new ZipArchive({
			zlib: { level: 6 }
		});

		archive.on('warning', (error: Error) => {
			stream.destroy(error);
		});

		// Prevent an unhandled archive error.
		archive.on('error', (error: Error) => {
			stream.destroy(error);
		});

		archive.pipe(stream);

		for (const file of files) {
			archive.file(file.path, {
				name: file.name
			});
		}

		void archive.finalize().catch((error: unknown) => {
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

		await this.prisma.audioGenerationJob.update({
			where: { id: jobId },
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
}
