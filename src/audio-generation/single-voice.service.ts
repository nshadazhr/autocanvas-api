import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GeminiTtsService } from './providers/gemini-tts.service.js';
import { mergeWavBuffers } from './utils/wav-merge.util.js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';

@Injectable()
export class SingleVoiceService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly tts: GeminiTtsService
	) {}

	async create(userId: number, title: string, content: string) {
		if (!content?.trim()) throw new BadRequestException('Script is required');
		if (content.length > 12000)
			throw new BadRequestException('Single Voice supports up to 12,000 characters per project');
		return this.prisma.audioStory.create({
			data: { userId, title: title?.trim() || 'Untitled Audio', content: content.trim(), status: 'SINGLE_DRAFT' }
		});
	}

	private async owned(storyId: number, userId: number) {
		const story = await this.prisma.audioStory.findFirst({ where: { id: storyId, userId } });
		if (!story || !story.status.startsWith('SINGLE_'))
			throw new NotFoundException('Single Voice project not found');
		return story;
	}

	async get(storyId: number, userId: number) {
		const story = await this.owned(storyId, userId);
		const audio = await this.prisma.audioAsset.findFirst({
			where: { storyId, type: 'SINGLE_VOICE' },
			orderBy: { created_at: 'desc' },
			select: { id: true, durationMs: true, created_at: true }
		});
		const config = story.analysisResult as { voiceId?: number } | null;
		return {
			id: story.id,
			title: story.title,
			content: story.content,
			status: story.status,
			voiceId: config?.voiceId ?? null,
			audio: audio ? { id: audio.id, durationMs: audio.durationMs, createdAt: audio.created_at } : null
		};
	}

	async generate(storyId: number, userId: number, voiceId: number) {
		const story = await this.owned(storyId, userId);
		if (story.status === 'SINGLE_PROCESSING') throw new BadRequestException('Generation is already running');
		if (!Number.isSafeInteger(voiceId) || voiceId <= 0) throw new BadRequestException('Select a voice');
		const voice = await this.prisma.voice.findUnique({
			where: { id: voiceId },
			include: { providerMapping: true }
		});
		if (!voice?.isActive || !voice.providerMapping || voice.providerMapping.provider.toUpperCase() !== 'GOOGLE')
			throw new BadRequestException('Voice is unavailable');
		if (!story.content.trim() || story.content.length > 12000)
			throw new BadRequestException('Script must be 1–12,000 characters');
		const changed = await this.prisma.audioStory.updateMany({
			where: { id: storyId, userId, status: { not: 'SINGLE_PROCESSING' } },
			data: { status: 'SINGLE_PROCESSING', analysisResult: { mode: 'single', voiceId } }
		});
		if (changed.count !== 1) throw new BadRequestException('Generation is already running');
		void this.run(storyId, story.content, voice.providerMapping.providerVoiceId, voice.providerMapping.model);
		return { status: 'SINGLE_PROCESSING' };
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

	private async run(storyId: number, text: string, voiceName: string, model: string) {
		try {
			const parts: Buffer[] = [];
			for (const chunk of this.split(text)) parts.push(await this.tts.generateSpeech(chunk, voiceName, model));
			const wav = parts.length === 1 ? parts[0] : mergeWavBuffers(parts, 180);
			const folder = resolve(process.cwd(), 'uploads', 'audio-stories', String(storyId), 'single');
			await mkdir(folder, { recursive: true });
			const filename = `${randomUUID()}.wav`;
			await writeFile(join(folder, filename), wav);
			const byteRate = wav.readUInt32LE(28);
			const dataSize = wav.readUInt32LE(40);
			await this.prisma.audioAsset.create({
				data: {
					storyId,
					type: 'SINGLE_VOICE',
					filePath: join('uploads', 'audio-stories', String(storyId), 'single', filename),
					mimeType: 'audio/wav',
					format: 'wav',
					fileSizeBytes: BigInt(wav.length),
					durationMs: byteRate ? Math.round((dataSize / byteRate) * 1000) : null
				}
			});
			await this.prisma.audioStory.update({ where: { id: storyId }, data: { status: 'SINGLE_COMPLETED' } });
		} catch (error) {
			// Keep the previously completed asset accessible when regeneration fails.
			await this.prisma.audioStory
				.update({ where: { id: storyId }, data: { status: 'SINGLE_FAILED' } })
				.catch(() => undefined);
			console.error(`Single Voice generation failed for story ${storyId}`, error);
		}
	}

	async file(storyId: number, audioId: number, userId: number) {
		await this.owned(storyId, userId);
		const audio = await this.prisma.audioAsset.findFirst({
			where: { id: audioId, storyId, type: 'SINGLE_VOICE' }
		});
		if (!audio) throw new NotFoundException('Audio not found');
		const root = resolve(process.cwd(), 'uploads', 'audio-stories', String(storyId), 'single');
		const path = resolve(process.cwd(), audio.filePath);
		const rel = relative(root, path);
		if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new NotFoundException('Audio not found');
		const info = await stat(path).catch(() => {
			throw new NotFoundException('Audio file missing');
		});
		return { path, size: info.size };
	}
}
