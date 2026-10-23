import { AiCapacityError } from '../ai/usage/ai-capacity.error.js';
import { safeAiError } from '../ai/usage/safe-ai-error.js';
import { BadRequestException, Injectable, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GeminiTtsService } from './providers/gemini-tts.service.js';
import { buildStylePrompt } from './providers/gemini-tts-prompt.builder.js';
import { shouldRetryWithNeutralPrompt } from './utils/gemini-tts-error.util.js';
import { mergeWavBuffers } from './utils/wav-merge.util.js';
import { randomUUID, createHash } from 'node:crypto';
import { withStoryLock } from './utils/audio-story-lock.js';
import { StorageService } from '../storage/storage.service.js';
interface SpeechSegment {
	text: string;
	emotion?: string;
}

const EMOTION_TAGS = [
	'happy',
	'sad',
	'angry',
	'excited',
	'whispers',
	'shouting',
	'crying',
	'laughing',
	'nervous',
	'scared',
	'surprised',
	'calm',
	'sarcastic',
	'serious'
] as const;

const SPEAKING_STYLES = ['Narrative', 'Storytelling', 'Conversational', 'Dramatic', 'Professional', 'Calm'] as const;

@Injectable()
export class SingleVoiceService implements OnModuleInit, OnModuleDestroy {
	private timer: ReturnType<typeof setInterval> | null = null;
	private scanning = false;
	constructor(
		private readonly prisma: PrismaService,
		private readonly tts: GeminiTtsService,
		private readonly storageService: StorageService
	) {}

	async create(userId: number, title: string, content: string) {
		if (!content?.trim()) {
			throw new BadRequestException('Script is required');
		}

		if (content.length > 12000) {
			throw new BadRequestException('Single Voice supports up to 12,000 characters per project');
		}

		return this.prisma.audioStory.create({
			data: {
				userId,
				title: title?.trim() || 'Untitled Audio',
				content: content.trim(),
				status: 'SINGLE_DRAFT'
			}
		});
	}

	private async owned(storyId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({
			where: {
				id: storyId,
				userId
			}
		});

		if (!story || !story.status.startsWith('SINGLE_')) {
			throw new NotFoundException('Single Voice project not found');
		}

		return story;
	}

	async get(storyId: number, userId: number) {
		const story = await this.owned(storyId, userId);

		const audio = await this.prisma.audioAsset.findFirst({
			where: {
				storyId,
				type: 'SINGLE_VOICE'
			},
			orderBy: {
				created_at: 'desc'
			},
			select: {
				id: true,
				durationMs: true,
				created_at: true
			}
		});

		const config = story.analysisResult as {
			voiceId?: number;
			style?: string;
			completedRevision?: string;
		} | null;

		return {
			id: story.id,
			title: story.title,
			content: story.content,
			status: story.status,
			voiceId: config?.voiceId ?? null,
			style: config?.style ?? null,
			error: story.analysisError,
			audioIsCurrent:
				!!audio &&
				(config?.completedRevision
					? config.completedRevision === this.revision(story.content, config.voiceId ?? 0, config.style)
					: story.status === 'SINGLE_COMPLETED'),
			audio: audio
				? {
						id: audio.id,
						durationMs: audio.durationMs,
						createdAt: audio.created_at
					}
				: null
		};
	}

	async cancel(storyId: number, userId: number) {
		await withStoryLock(this.prisma, storyId, async tx => {
			const story = await tx.audioStory.findFirst({ where: { id: storyId, userId } });
			if (!story?.status.startsWith('SINGLE_')) throw new NotFoundException('Single Voice project not found');
			if (!['SINGLE_PENDING', 'SINGLE_PROCESSING'].includes(story.status)) return;
			await tx.audioStory.update({
				where: { id: storyId },
				data: { status: 'SINGLE_CANCELLED', analysisAttemptId: null, analysisError: null }
			});
		});
		return this.get(storyId, userId);
	}

	async generate(
		storyId: number,
		userId: number,
		voiceId: number,
		style?: string,
		draft?: { title?: string; content?: string }
	) {
		const selectedStyle = style?.trim() || '';
		if (selectedStyle && !SPEAKING_STYLES.some(item => item.toLowerCase() === selectedStyle.toLowerCase()))
			throw new BadRequestException('Invalid speaking style');
		const normalizedStyle = SPEAKING_STYLES.find(item => item.toLowerCase() === selectedStyle.toLowerCase());
		await withStoryLock(this.prisma, storyId, async tx => {
			const story = await tx.audioStory.findFirst({ where: { id: storyId, userId } });
			if (!story?.status.startsWith('SINGLE_')) throw new NotFoundException('Single Voice project not found');
			if (['SINGLE_PENDING', 'SINGLE_PROCESSING'].includes(story.status))
				throw new BadRequestException('Generation is already running');
			const content = draft?.content?.trim() ?? story.content;
			if (!content || content.length > 12000 || this.parseEmotionSegments(content).length === 0)
				throw new BadRequestException('Script must contain speakable text and be at most 12,000 characters');
			const voice = await tx.voice.findUnique({ where: { id: voiceId } });
			if (!voice?.isActive || !['GOOGLE', 'GEMINI'].includes(voice.provider.toUpperCase()))
				throw new BadRequestException('Voice is unavailable');
			const previous = story.analysisResult as Record<string, any> | null;
			await tx.audioStory.update({
				where: { id: storyId },
				data: {
					title: draft?.title?.trim() || story.title,
					content,
					status: 'SINGLE_PENDING',
					analysisError: null,
					analysisResult: {
						mode: 'single',
						voiceId,
						style: normalizedStyle ?? null,
						completedRevision: previous?.completedRevision ?? null
					}
				}
			});
		});
		void this.processPending(storyId).catch(error => console.error('Single Voice dispatch failed', error));
		return { status: 'SINGLE_PENDING' };
	}

	private async processPending(storyId: number) {
		const attemptId = randomUUID();
		const claimed = await this.prisma.audioStory.updateMany({
			where: { id: storyId, status: 'SINGLE_PENDING' },
			data: { status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId }
		});
		if (claimed.count !== 1) return;
		const heartbeat = setInterval(() => {
			void this.prisma.audioStory
				.updateMany({
					where: { id: storyId, status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId },
					data: { updated_at: new Date() }
				})
				.catch(error => console.error('Single Voice heartbeat failed', error));
		}, 30_000);
		heartbeat.unref();
		try {
			const story = await this.prisma.audioStory.findUnique({ where: { id: storyId } });
			const config = story?.analysisResult as { voiceId?: number; style?: string } | null;
			const voice = config?.voiceId
				? await this.prisma.voice.findUnique({ where: { id: config.voiceId } })
				: null;
			if (!story || !voice?.isActive) throw new BadRequestException('Voice is unavailable');
			await this.run(
				storyId,
				this.parseEmotionSegments(story.content),
				voice.providerVoiceId,
				voice.model,
				config?.style ?? undefined,
				attemptId,
				story.userId
			);
		} catch (error) {
			await this.prisma.audioStory.updateMany({
				where: { id: storyId, status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId },
				data: {
					status: 'SINGLE_FAILED',
					analysisError: safeAiError(error)
				}
			});
		} finally {
			clearInterval(heartbeat);
		}
	}

	private async resumePending() {
		if (this.scanning) return;
		this.scanning = true;
		try {
			// Only stale processors are recovered; healthy replicas refresh updated_at.
			await this.prisma.audioStory.updateMany({
				where: { status: 'SINGLE_PROCESSING', updated_at: { lt: new Date(Date.now() - 5 * 60_000) } },
				data: { status: 'SINGLE_FAILED', analysisError: 'Generation was interrupted. Please retry.' }
			});
			const pending = await this.prisma.audioStory.findMany({
				where: { status: 'SINGLE_PENDING' },
				select: { id: true }
			});
			for (const story of pending)
				void this.processPending(story.id).catch(error => console.error('Single Voice dispatch failed', error));
		} finally {
			this.scanning = false;
		}
	}

	async onModuleInit() {
		await this.resumePending();
		this.timer = setInterval(() => {
			void this.resumePending().catch(error => console.error('Single Voice recovery failed', error));
		}, 30_000);
		this.timer.unref();
	}

	onModuleDestroy() {
		if (this.timer) clearInterval(this.timer);
	}

	private parseEmotionSegments(text: string): SpeechSegment[] {
		const segments: SpeechSegment[] = [];

		const supported = new Set<string>(EMOTION_TAGS);

		const tagRegex = /\[([a-z]+)\]/gi;

		let currentEmotion: string | undefined;
		let cursor = 0;

		for (const match of text.matchAll(tagRegex)) {
			const emotion = match[1].toLowerCase();

			if (!supported.has(emotion)) {
				continue;
			}

			const start = match.index ?? 0;

			const before = text.slice(cursor, start).trim();

			if (before) {
				segments.push({
					text: before,
					emotion: currentEmotion
				});
			}

			currentEmotion = emotion;
			cursor = start + match[0].length;
		}

		const remaining = text.slice(cursor).trim();

		if (remaining) {
			segments.push({
				text: remaining,
				emotion: currentEmotion
			});
		}

		return segments.flatMap(segment =>
			this.split(segment.text).map(chunk => ({
				text: chunk,
				emotion: segment.emotion
			}))
		);
	}

	private split(text: string): string[] {
		const result: string[] = [];

		let remaining = text.trim();

		while (remaining.length) {
			if (remaining.length <= 1500) {
				result.push(remaining);
				break;
			}

			const head = remaining.slice(0, 1500);

			const breaks = [...head.matchAll(/[\n।.!?]\s*/g)];

			const cut =
				breaks.length && breaks[breaks.length - 1].index! > 650
					? breaks[breaks.length - 1].index! + breaks[breaks.length - 1][0].length
					: Math.max(head.lastIndexOf(' ', 1500), 1000);

			result.push(remaining.slice(0, cut).trim());

			remaining = remaining.slice(cut).trim();
		}

		return result;
	}

	private async generateSegment(
		segment: SpeechSegment,
		voiceName: string,
		model: string,
		userId: number,
		style: string | undefined,
		storyId: number,
		attemptId: string
	): Promise<Buffer> {
		const promptOptions = {
			text: segment.text,
			style: style || undefined,
			emotion: segment.emotion
		};

		const prompt = style || segment.emotion ? buildStylePrompt(promptOptions) : segment.text;

		try {
			return await this.tts.generateSpeech(prompt, voiceName, model, { userId });
		} catch (error) {
			if (!shouldRetryWithNeutralPrompt(error)) {
				throw error;
			}

			if (
				!(await this.prisma.audioStory.findFirst({
					where: { id: storyId, status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId },
					select: { id: true }
				}))
			)
				throw new Error('Generation cancelled');
			console.warn('Single Voice: Safety error. Retrying with neutral prompt.');

			const fallbackPrompt = buildStylePrompt({
				...promptOptions,
				neutralFallback: true
			});

			return this.tts.generateSpeech(fallbackPrompt, voiceName, model, { userId });
		}
	}

	private async run(
		storyId: number,
		segments: SpeechSegment[],
		voiceName: string,
		model: string,
		style: string | undefined,
		attemptId: string,
		userId: number
	) {
		try {
			const parts: Buffer[] = [];

			for (const segment of segments) {
				let wav: Buffer;
				for (;;) {
					const owner = await this.prisma.audioStory.findFirst({
						where: { id: storyId, status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId },
						select: { id: true }
					});
					if (!owner) return;
					try {
						wav = await this.generateSegment(segment, voiceName, model, userId, style, storyId, attemptId);
						break;
					} catch (error) {
						if (!(error instanceof AiCapacityError)) throw error;
						// Keep completed chunks while the shared provider budget is busy.
						await new Promise(resolve =>
							setTimeout(
								resolve,
								Math.min(30_000, Math.max(100, error.nextRetryAt.getTime() - Date.now()))
							)
						);
					}
				}

				parts.push(wav);
			}

			if (
				!(await this.prisma.audioStory.findFirst({
					where: { id: storyId, status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId },
					select: { id: true }
				}))
			)
				return;
			const wav = parts.length === 1 ? parts[0] : mergeWavBuffers(parts, 180);

			const filename = `${randomUUID()}.wav`;

			const filePath = await this.storageService.upload({
				key: `audio-stories/${storyId}/single/${filename}`,
				buffer: wav,
				contentType: 'audio/wav'
			});

			const byteRate = wav.readUInt32LE(28);
			const dataSize = wav.readUInt32LE(40);

			await withStoryLock(this.prisma, storyId, async tx => {
				const story = await tx.audioStory.findFirst({
					where: { id: storyId, status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId }
				});
				if (!story) return;
				const config = story.analysisResult as { voiceId: number; style?: string };
				await tx.audioAsset.create({
					data: {
						storyId,
						type: 'SINGLE_VOICE',
						filePath,
						mimeType: 'audio/wav',
						format: 'wav',
						fileSizeBytes: BigInt(wav.length),
						durationMs: byteRate ? Math.round((dataSize / byteRate) * 1000) : null
					}
				});
				await tx.audioStory.update({
					where: { id: storyId },
					data: {
						status: 'SINGLE_COMPLETED',
						analysisError: null,
						analysisAttemptId: null,
						analysisResult: {
							...config,
							completedRevision: this.revision(story.content, config.voiceId, config.style)
						}
					}
				});
			});
		} catch (error) {
			// Keep the previously completed asset accessible
			// when regeneration fails.
			await this.prisma.audioStory
				.updateMany({
					where: { id: storyId, status: 'SINGLE_PROCESSING', analysisAttemptId: attemptId },
					data: {
						status: 'SINGLE_FAILED',
						analysisError: safeAiError(error)
					}
				})
				.catch(() => undefined);

			console.error(`Single Voice generation failed for story ${storyId}`, error);
		}
	}

	private revision(content: string, voiceId: number, style?: string | null) {
		return createHash('sha256')
			.update(JSON.stringify([content, voiceId, style ?? null]))
			.digest('hex');
	}

	async file(storyId: number, audioId: number, userId: number) {
		await this.owned(storyId, userId);

		const audio = await this.prisma.audioAsset.findFirst({
			where: {
				id: audioId,
				storyId,
				type: 'SINGLE_VOICE'
			}
		});

		if (!audio) {
			throw new NotFoundException('Audio not found');
		}

		return this.storageService.getFile(audio.filePath);
	}
}
