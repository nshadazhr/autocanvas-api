import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GeminiTtsService } from './providers/gemini-tts.service.js';
import { buildStylePrompt } from './providers/gemini-tts-prompt.builder.js';
import { shouldRetryWithNeutralPrompt } from './utils/gemini-tts-error.util.js';
import { mergeWavBuffers } from './utils/wav-merge.util.js';
import { randomUUID } from 'node:crypto';
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
export class SingleVoiceService {
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
		} | null;

		return {
			id: story.id,
			title: story.title,
			content: story.content,
			status: story.status,
			voiceId: config?.voiceId ?? null,
			style: config?.style ?? null,
			audio: audio
				? {
						id: audio.id,
						durationMs: audio.durationMs,
						createdAt: audio.created_at
					}
				: null
		};
	}

	async generate(storyId: number, userId: number, voiceId: number, style?: string) {
		const story = await this.owned(storyId, userId);

		if (story.status === 'SINGLE_PROCESSING') {
			throw new BadRequestException('Generation is already running');
		}

		if (!Number.isSafeInteger(voiceId) || voiceId <= 0) {
			throw new BadRequestException('Select a voice');
		}

		const selectedStyle = style?.trim() || '';

		if (selectedStyle && !SPEAKING_STYLES.some(item => item.toLowerCase() === selectedStyle.toLowerCase())) {
			throw new BadRequestException('Invalid speaking style');
		}

		const normalizedStyle = SPEAKING_STYLES.find(item => item.toLowerCase() === selectedStyle.toLowerCase());

		const voice = await this.prisma.voice.findUnique({
			where: {
				id: voiceId
			}
		});

		if (!voice?.isActive || !['GOOGLE', 'GEMINI'].includes(voice.provider.toUpperCase())) {
			throw new BadRequestException('Voice is unavailable');
		}

		console.log('SINGLE VOICE DEBUG:', {
			storyId,
			requestedVoiceId: voiceId,
			databaseVoiceId: voice.id,
			voiceName: voice.name,
			provider: voice.provider,
			providerVoiceId: voice.providerVoiceId,
			model: voice.model,
			selectedStyle: normalizedStyle ?? 'Natural'
		});

		if (!story.content.trim() || story.content.length > 12000) {
			throw new BadRequestException('Script must be 1–12,000 characters');
		}

		const segments = this.parseEmotionSegments(story.content);

		if (segments.length === 0) {
			throw new BadRequestException('Script has no speakable text');
		}

		const changed = await this.prisma.audioStory.updateMany({
			where: {
				id: storyId,
				userId,
				status: {
					not: 'SINGLE_PROCESSING'
				}
			},
			data: {
				status: 'SINGLE_PROCESSING',
				analysisResult: {
					mode: 'single',
					voiceId,
					style: normalizedStyle ?? null
				}
			}
		});

		if (changed.count !== 1) {
			throw new BadRequestException('Generation is already running');
		}

		void this.run(storyId, segments, voice.providerVoiceId, voice.model, normalizedStyle);

		return {
			status: 'SINGLE_PROCESSING'
		};
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
		style?: string
	): Promise<Buffer> {
		const promptOptions = {
			text: segment.text,
			style: style || undefined,
			emotion: segment.emotion
		};

		const prompt = style || segment.emotion ? buildStylePrompt(promptOptions) : segment.text;

		try {
			return await this.tts.generateSpeech(prompt, voiceName, model);
		} catch (error) {
			if (!shouldRetryWithNeutralPrompt(error)) {
				throw error;
			}

			console.warn('Single Voice: Safety error. Retrying with neutral prompt.');

			const fallbackPrompt = buildStylePrompt({
				...promptOptions,
				neutralFallback: true
			});

			return this.tts.generateSpeech(fallbackPrompt, voiceName, model);
		}
	}

	private async run(storyId: number, segments: SpeechSegment[], voiceName: string, model: string, style?: string) {
		try {
			const parts: Buffer[] = [];

			for (const segment of segments) {
				const wav = await this.generateSegment(segment, voiceName, model, style);

				parts.push(wav);
			}

			const wav = parts.length === 1 ? parts[0] : mergeWavBuffers(parts, 180);

			const filename = `${randomUUID()}.wav`;

			const filePath = await this.storageService.upload({
				key: `audio-stories/${storyId}/single/${filename}`,
				buffer: wav,
				contentType: 'audio/wav'
			});

			const byteRate = wav.readUInt32LE(28);
			const dataSize = wav.readUInt32LE(40);

			await this.prisma.audioAsset.create({
				data: {
					storyId,
					type: 'SINGLE_VOICE',
					filePath: filePath,
					mimeType: 'audio/wav',
					format: 'wav',
					fileSizeBytes: BigInt(wav.length),
					durationMs: byteRate ? Math.round((dataSize / byteRate) * 1000) : null
				}
			});

			await this.prisma.audioStory.update({
				where: {
					id: storyId
				},
				data: {
					status: 'SINGLE_COMPLETED'
				}
			});
		} catch (error) {
			// Keep the previously completed asset accessible
			// when regeneration fails.
			await this.prisma.audioStory
				.update({
					where: {
						id: storyId
					},
					data: {
						status: 'SINGLE_FAILED'
					}
				})
				.catch(() => undefined);

			console.error(`Single Voice generation failed for story ${storyId}`, error);
		}
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
