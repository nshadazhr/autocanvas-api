import { CreditsService } from '../credits/credits.service.js';
import { sceneDownloadFilename } from './utils/scene-download-filename.js';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { audioGenerationService } from './audio-generation.service.js';
import { SingleVoiceService } from './single-voice.service.js';
import { AudioStoriesService } from '../audio-stories/audio-stories.service.js';
import { ProviderRateLimitError } from './errors/provider-rate-limit.error.js';
import { sceneAudioRevision } from './utils/scene-audio-revision.js';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AudioGenerationController } from './audio-generation.controller.js';
import { SingleVoiceController } from './single-voice.controller.js';
import { StorageService } from '../storage/storage.service.js';
import { AuthGuard } from '../auth/auth.guard.js';

// Opt-in integration tests. Never fall back to the application's DATABASE_URL.
const databaseUrl = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (databaseUrl) {
	const url = new URL(databaseUrl);
	if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test'))
		throw new Error('Audio flow tests require a local disposable database ending in _test');
}

describe.skipIf(!databaseUrl)('audio flow with real PostgreSQL and stubbed Gemini/storage', () => {
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
	const files = new Map<string, Buffer>();
	const wav = Buffer.alloc(48044);
	wav.write('RIFF');
	wav.writeUInt32LE(48036, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(24000, 24);
	wav.writeUInt32LE(48000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(48000, 40);
	const tts = {
		assertEnabled: async () => undefined,
		generateSpeech: vi.fn(async (_text: string, _voice: string, _model: string) => wav)
	};
	const storage = {
		upload: vi.fn(async ({ key, buffer }: { key: string; buffer: Buffer }) => {
			files.set(key, buffer);
			return key;
		}),
		getMetadata: vi.fn(async (key: string) => {
			if (!files.has(key)) throw new Error('Missing file');
			return { size: files.get(key)!.length, contentType: 'audio/wav' };
		}),
		getFile: vi.fn(async (key: string, options?: { start?: number; end?: number }) => {
			if (!files.has(key)) throw new Error('Missing file');
			return {
				stream: Readable.from(
					files
						.get(key)!
						.subarray(options?.start ?? 0, options?.end === undefined ? undefined : options.end + 1)
				),
				size: files.get(key)!.length,
				contentType: 'audio/wav'
			};
		})
	};
	const service = new audioGenerationService(
		prisma as any,
		tts as any,
		{ get: () => undefined } as any,
		storage as any,
		{ section: async () => ({ values: { maxRecoveryAttempts: 3, recoveryRetryDelayMs: 60000 } }) } as any,
		new CreditsService(prisma as any)
	);
	const single = new SingleVoiceService(prisma as any, tts as any, storage as any, new CreditsService(prisma as any));
	const stories = new AudioStoriesService(
		prisma as any,
		{} as any,
		{} as any,
		{} as any,
		{} as any,
		{} as any,
		new CreditsService(prisma as any)
	);
	let userId: number;
	let voice: any;
	let story: any;
	let scenes: any[];
	let app: INestApplication;
	let token: string;
	const jwt = new JwtService({ secret: 'isolated-audio-integration-fixture' });

	async function waitFor(check: () => Promise<boolean>) {
		for (let i = 0; i < 100; i++) {
			if (await check()) return;
			await new Promise(resolve => setTimeout(resolve, 30));
		}
		throw new Error('Timed out waiting for generation');
	}
	async function collect(stream: Readable) {
		const parts: Buffer[] = [];
		for await (const part of stream) parts.push(Buffer.from(part));
		return Buffer.concat(parts);
	}

	beforeAll(async () => {
		await prisma.$connect();
		const user = await prisma.user.create({ data: { email: `audio-test-${randomUUID()}@example.test` } });
		userId = user.id;
		voice = await prisma.voice.create({
			data: {
				name: 'Fixture voice',
				provider: 'GEMINI',
				providerVoiceId: `fixture-${randomUUID()}`,
				model: 'fixture-model',
				isActive: true
			}
		});
		// Vite does not emit TS decorator parameter metadata. Supply it for the
		// test module; production Nest builds emit the same metadata with tsc.
		Reflect.defineMetadata(
			'design:paramtypes',
			[audioGenerationService, StorageService],
			AudioGenerationController
		);
		Reflect.defineMetadata('design:paramtypes', [SingleVoiceService], SingleVoiceController);
		const module = await Test.createTestingModule({
			controllers: [AudioGenerationController, SingleVoiceController],
			providers: [
				{ provide: audioGenerationService, useValue: service },
				{ provide: SingleVoiceService, useValue: single },
				{ provide: StorageService, useValue: storage },
				{ provide: JwtService, useValue: jwt }
			]
		})
			.overrideGuard(AuthGuard)
			.useValue(new AuthGuard({ verifyAccessToken: (token: string) => jwt.verifyAsync(token) } as any))
			.compile();
		app = module.createNestApplication();
		app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
		await app.init();
		token = jwt.sign({ id: userId });
	});
	afterAll(async () => {
		if (app) await app.close();
		service.onModuleDestroy();
		single.onModuleDestroy();
		await prisma.audioGenerationJob.deleteMany({ where: { userId } });
		await prisma.audioScene.deleteMany({ where: { story: { userId } } });
		await prisma.audioStory.deleteMany({ where: { userId } });
		await prisma.creditTransaction.deleteMany({ where: { userId } });
		await prisma.creditPurchase.deleteMany({ where: { userId } });
		await prisma.user.delete({ where: { id: userId } });
		await prisma.voice.delete({ where: { id: voice.id } });
		await prisma.$disconnect();
	});
	afterEach(async () => {
		await prisma.audioGenerationJob.updateMany({
			where: { userId, status: { in: ['PENDING', 'PROCESSING', 'WAITING'] } },
			data: { status: 'CANCELLED' }
		});
	});

	beforeEach(async () => {
		await prisma.configuration.upsert({
			where: { key: 'credits_settings' },
			create: { key: 'credits_settings', value: {} },
			update: { value: {} }
		});
		await prisma.user.update({ where: { id: userId }, data: { creditBalance: 100, creditWelcomeGranted: true } });
		tts.generateSpeech.mockReset();
		tts.generateSpeech.mockResolvedValue(wav);
		story = await prisma.audioStory.create({
			data: {
				userId,
				title: 'Audio fixture',
				content: 'First. Second.',
				status: 'READY',
				analysisStatus: 'COMPLETED',
				analysisResult: { validation: { valid: true } }
			}
		});
		const character = await prisma.audioCharacter.create({
			data: { storyId: story.id, name: 'Narrator', gender: 'Male', voiceId: voice.id }
		});
		for (let order = 1; order <= 2; order++)
			await prisma.audioScene.create({
				data: {
					storyId: story.id,
					characterId: character.id,
					sceneOrder: order,
					speakerName: 'Narrator',
					text: `Scene ${order}`,
					emotion: 'Calm',
					style: 'Narration',
					language: 'hi-IN'
				}
			});
		scenes = await prisma.audioScene.findMany({
			where: { storyId: story.id },
			orderBy: { sceneOrder: 'asc' }
		});
	});

	it('settles paid partial work and charges only the successful failed-scene retry', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { audioCreditsPer1000Characters: 1000 } }
		});
		tts.generateSpeech.mockRejectedValueOnce(new Error('Invalid voice configuration'));
		const first = await service.createGenerationJob(story.id, userId);
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(86);
		await service.processGenerationJob(first.id);
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(93);
		const retry = await service.retryFailedJob(first.id, userId);
		await service.processGenerationJob(retry.id);
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(86);
	});
	it('refunds paid pending cancellation exactly once', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { audioCreditsPer1000Characters: 1000 } }
		});
		const job = await service.createGenerationJob(story.id, userId);
		await service.cancelGenerationJob(job.id, userId);
		await service.cancelGenerationJob(job.id, userId);
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(100);
		expect(await prisma.creditTransaction.count({ where: { userId, storyId: story.id, status: 'RESERVED' } })).toBe(
			0
		);
	});

	it('serializes concurrent full-job requests: exactly one job is committed', async () => {
		const results = await Promise.allSettled([
			service.createGenerationJob(story.id, userId),
			service.createGenerationJob(story.id, userId)
		]);
		expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
		expect(await prisma.audioGenerationJob.count({ where: { storyId: story.id } })).toBe(1);
	});
	it('blocks a single-scene job while full generation is pending', async () => {
		await service.createGenerationJob(story.id, userId);
		await expect(service.createSingleSceneJob(story.id, scenes[0].id, userId)).rejects.toThrow('already running');
	});
	it('rejects missing voice assignments without creating a job', async () => {
		await prisma.audioCharacter.updateMany({ where: { storyId: story.id }, data: { voiceId: null } });
		await expect(service.createGenerationJob(story.id, userId)).rejects.toThrow('voice');
		expect(await prisma.audioGenerationJob.count({ where: { storyId: story.id } })).toBe(0);
	});
	it('rejects pending or invalid analysis', async () => {
		await prisma.audioStory.update({ where: { id: story.id }, data: { analysisStatus: 'PENDING' } });
		await expect(service.createGenerationJob(story.id, userId)).rejects.toThrow('analysis');
	});
	it('checks ownership before exposing an active job', async () => {
		await service.createGenerationJob(story.id, userId);
		await expect(service.createGenerationJob(story.id, userId + 10000)).rejects.toThrow('not found');
	});
	it('completes real job rows, links audio, serves playback bytes, ZIP and combined WAV', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		const result = await service.getGenerationJob(job.id, userId);
		expect(result.status).toBe('COMPLETED');
		expect(result.completedScenes).toBe(2);
		const history = await service.getStoryAudioHistory(story.id, userId);
		expect(history.generatedScenes).toBe(2);
		const audioFile = await service.getAudioFile(history.scenes[0].latestAudio!.id, userId);
		expect(await collect((await storage.getFile(audioFile.filePath)).stream)).toEqual(wav);
		const zip = await service.downloadStoryAudioZip(story.id, userId);
		expect((await collect(zip.stream)).subarray(0, 2).toString()).toBe('PK');
		const combined = await service.exportStoryWav(story.id, userId);
		expect(combined.durationMs).toBeGreaterThan(1900);
		const exported = await service.getExportedAudioFile(combined.id, userId);
		expect(files.get(exported.filePath)!.subarray(0, 4).toString()).toBe('RIFF');
	});
	it('deletes a completed generated story without scene/job foreign-key errors and preserves its ledger', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		const entries = await prisma.creditTransaction.count({ where: { userId, storyId: story.id } });
		await stories.remove(story.id, userId);
		expect(await prisma.audioStory.findUnique({ where: { id: story.id } })).toBeNull();
		expect(await prisma.audioGenerationJob.count({ where: { storyId: story.id } })).toBe(0);
		expect(await prisma.audioScene.count({ where: { storyId: story.id } })).toBe(0);
		expect(await prisma.creditTransaction.count({ where: { userId, storyId: story.id } })).toBe(entries);
	});
	it('rejects story deletion during active generation without deleting its job', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await expect(stories.remove(story.id, userId)).rejects.toThrow();
		expect(await prisma.audioGenerationJob.findUnique({ where: { id: job.id } })).not.toBeNull();
	});

	it('two processors claiming the same job generate each scene once', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await Promise.all([service.processGenerationJob(job.id), service.processGenerationJob(job.id)]);
		const saved = await prisma.sceneAudio.findMany({ where: { scene: { storyId: story.id } } });
		expect(
			saved.every(audio =>
				/audio-stories\/multiple-voice\/story_\d+_[A-Za-z0-9_]+\/job-\d+\/take-[a-f0-9-]+\/\d{3}_[A-Za-z0-9_]+\.wav$/.test(
					audio.filePath
				)
			)
		).toBe(true);
		expect(tts.generateSpeech).toHaveBeenCalledTimes(2);
	});
	it('records permanent scene errors and continues remaining scenes', async () => {
		tts.generateSpeech.mockRejectedValueOnce(new Error('Invalid voice configuration'));
		const job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		const result = await service.getGenerationJob(job.id, userId);
		expect(result.status).toBe('PARTIAL');
		expect(result.failedScenes).toBe(1);
		expect(result.completedScenes).toBe(1);
		expect(result.items[0].error).toContain('Invalid voice');
	});
	it('waits on quota with nextRetryAt and refunds the attempt', async () => {
		tts.generateSpeech.mockRejectedValueOnce(
			new ProviderRateLimitError('Quota waiting', new Date(Date.now() + 60000))
		);
		const job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		const result = await service.getGenerationJob(job.id, userId);
		expect(result.status).toBe('WAITING');
		expect(result.items[0].attempts).toBe(0);
		expect(result.items[0].nextRetryAt).toBeTruthy();
	});
	it('bounds transient no-audio retries and then terminates FAILED', async () => {
		tts.generateSpeech.mockRejectedValue(new Error('Gemini returned no audio'));
		const job = await service.createSingleSceneJob(story.id, scenes[0].id, userId);
		for (let i = 0; i < 3; i++) {
			await prisma.audioGenerationJobItem.updateMany({
				where: { jobId: job.id },
				data: { nextRetryAt: new Date(0) }
			});
			await service.processGenerationJob(job.id);
		}
		const result = await service.getGenerationJob(job.id, userId);
		expect(result.status).toBe('FAILED');
		expect(result.items[0].attempts).toBe(3);
	});
	it('manual retry includes only failed scenes and rejects overlapping retries', async () => {
		tts.generateSpeech.mockRejectedValueOnce(new Error('Invalid voice configuration'));
		const first = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(first.id);
		const results = await Promise.allSettled([
			service.retryFailedJob(first.id, userId),
			service.retryFailedJob(first.id, userId)
		]);
		expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
		const retry = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
		expect(retry.totalScenes).toBe(1);
		await service.processGenerationJob(retry.id);
		expect((await service.getStoryAudioHistory(story.id, userId)).generatedScenes).toBe(2);
	});
	it('recovery scanner picks up a pending job without controller dispatch', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await (service as any).resumeWaitingJobs();
		await waitFor(async () => (await service.getGenerationJob(job.id, userId)).status === 'COMPLETED');
	});
	it('recovers stale processors while leaving healthy replicas alone', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await prisma.audioGenerationJob.update({ where: { id: job.id }, data: { status: 'PROCESSING' } });
		await service.recoverInterruptedJobs();
		expect((await service.getGenerationJob(job.id, userId)).status).toBe('PROCESSING');
		await prisma.audioGenerationJob.update({ where: { id: job.id }, data: { updated_at: new Date(0) } });
		await prisma.audioGenerationJobItem.updateMany({
			where: { jobId: job.id },
			data: { status: 'PROCESSING', attempts: 1 }
		});
		await service.recoverInterruptedJobs();
		expect((await service.getGenerationJob(job.id, userId)).status).toBe('WAITING');
	});
	it('a recovered job reuses an audio asset already committed for its item', async () => {
		const job = await service.createSingleSceneJob(story.id, scenes[0].id, userId);
		const item = (await service.getGenerationJob(job.id, userId)).items[0];
		await service.generateSceneAudio(item.sceneId, undefined, undefined, undefined, item.id);
		tts.generateSpeech.mockClear();
		await service.processGenerationJob(job.id);
		expect(tts.generateSpeech).not.toHaveBeenCalled();
		expect((await service.getGenerationJob(job.id, userId)).status).toBe('COMPLETED');
	});
	it('refuses publishing audio from an obsolete worker', async () => {
		const job = await service.createSingleSceneJob(story.id, scenes[0].id, userId);
		const item = (await service.getGenerationJob(job.id, userId)).items[0];
		await expect(
			service.generateSceneAudio(item.sceneId, undefined, undefined, undefined, item.id, {
				jobId: job.id,
				startedAt: new Date(0)
			})
		).rejects.toThrow('ownership expired');
		expect(await prisma.sceneAudio.count({ where: { jobItemId: item.id } })).toBe(0);
	});
	it('latest-job endpoint restores a single-scene active job', async () => {
		const job = await service.createSingleSceneJob(story.id, scenes[0].id, userId);
		expect((await service.getLatestStoryJob(story.id, userId))?.id).toBe(job.id);
	});
	it('re-analysis retires removed/edited scene IDs and preserves historical audio', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		await prisma.$transaction(tx =>
			(stories as any).syncScenes(tx, story.id, [
				{
					sceneOrder: 1,
					speakerName: 'Narrator',
					text: 'Changed',
					language: 'hi-IN',
					emotion: 'Calm',
					style: 'Narration'
				}
			])
		);
		const history = await service.getStoryAudioHistory(story.id, userId);
		expect(history.totalScenes).toBe(1);
		expect(history.generatedScenes).toBe(0);
		expect(history.scenes[0].id).not.toBe(scenes[0].id);
		expect(await prisma.sceneAudio.count({ where: { scene: { storyId: story.id } } })).toBe(2);
		await expect(service.downloadStoryAudioZip(story.id, userId)).rejects.toThrow('Audio missing');
		await expect(service.retryFailedJob(job.id, userId)).rejects.toThrow();
	});
	it('voice changes invalidate current audio; retired jobs cannot retry stale text', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		await prisma.audioCharacter.updateMany({ where: { storyId: story.id }, data: { voiceId: null } });
		expect((await service.getStoryAudioHistory(story.id, userId)).generatedScenes).toBe(0);
	});
	it('editing and changing cast are blocked during generation', async () => {
		await service.createGenerationJob(story.id, userId);
		await expect(stories.update(story.id, userId, { content: 'Changed' })).rejects.toThrow('already running');
		await expect(
			stories.updateCast(story.id, userId, {
				characters: [{ name: 'Narrator', gender: 'Male', voiceId: voice.id }]
			})
		).rejects.toThrow('already running');
	});
	it('history preserves latest failure alongside previous playable audio', async () => {
		let job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		tts.generateSpeech.mockRejectedValue(new Error('Invalid configuration'));
		job = await service.createSingleSceneJob(story.id, scenes[0].id, userId);
		await service.processGenerationJob(job.id);
		const history = await service.getStoryAudioHistory(story.id, userId);
		expect(history.scenes[0].latestAudio).toBeTruthy();
		expect(history.scenes[0].lastGeneration?.status).toBe('FAILED');
	});
	it('charges a paid single-voice output and charges a new manual regeneration', async () => {
		await prisma.configuration.update({
			where: { key: 'credits_settings' },
			data: { value: { audioCreditsPer1000Characters: 1000 } }
		});
		const project = await single.create(userId, 'Paid single', 'Hello');
		await single.generate(project.id, userId, voice.id);
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(95);
		await single.generate(project.id, userId, voice.id);
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
		expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).creditBalance).toBe(90);
	});

	it('single-voice generation saves changed draft text before regeneration', async () => {
		const project = await single.create(userId, 'Draft', 'Old script');
		await single.generate(project.id, userId, voice.id);
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
		tts.generateSpeech.mockClear();
		await single.generate(project.id, userId, voice.id, 'Calm', {
			title: 'Edited title',
			content: 'Changed script'
		});
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
		const updated = await single.get(project.id, userId);
		expect(updated.title).toBe('Edited title');
		expect(updated.content).toBe('Changed script');
		expect(updated.audioIsCurrent).toBe(true);
		expect(tts.generateSpeech.mock.calls.some(call => call[0].includes('Changed script'))).toBe(true);
	});
	it('single-voice restart recovers pending and releases stale processing state', async () => {
		const project = await single.create(userId, 'Interrupted', 'Old script');
		await prisma.audioStory.update({
			where: { id: project.id },
			data: { status: 'SINGLE_PROCESSING', updated_at: new Date(0) }
		});
		await (single as any).resumePending();
		expect((await single.get(project.id, userId)).status).toBe('SINGLE_FAILED');
		await single.generate(project.id, userId, voice.id);
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
	});
	it('revision changes for emotion/style as well as text and voice', () => {
		expect(sceneAudioRevision(scenes[0], voice)).not.toBe(
			sceneAudioRevision({ ...scenes[0], emotion: 'Angry' }, voice)
		);
	});

	it('rejects exports when the current audio file is missing from storage', async () => {
		const job = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(job.id);
		const history = await service.getStoryAudioHistory(story.id, userId);
		const audio = await service.getAudioFile(history.scenes[0].latestAudio!.id, userId);
		files.delete(audio.filePath);
		await expect(service.downloadStoryAudioZip(story.id, userId)).rejects.toThrow('Missing file');
	});

	it('records storage upload failure without marking the scene completed', async () => {
		storage.upload.mockRejectedValueOnce(new Error('Storage upload failed'));
		const job = await service.createSingleSceneJob(story.id, scenes[0].id, userId);
		await service.processGenerationJob(job.id);
		const result = await service.getGenerationJob(job.id, userId);
		expect(result.status).toBe('FAILED');
		expect(result.items[0].error).toContain('Storage upload failed');
		expect(await prisma.sceneAudio.count({ where: { sceneId: scenes[0].id } })).toBe(0);
	});

	it('recovers a journaled single-voice pending request without a controller', async () => {
		const project = await single.create(userId, 'Pending', 'Persisted script');
		await prisma.audioStory.update({
			where: { id: project.id },
			data: { status: 'SINGLE_PENDING', analysisResult: { voiceId: voice.id } }
		});
		await (single as any).resumePending();
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
	});

	it('serializes concurrent single-voice generate requests', async () => {
		const project = await single.create(userId, 'Concurrent', 'Single voice script');
		const results = await Promise.allSettled([
			single.generate(project.id, userId, voice.id),
			single.generate(project.id, userId, voice.id)
		]);
		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
	});

	it('rejects stale failed-scene retries after re-analysis replaced their scene IDs', async () => {
		tts.generateSpeech.mockRejectedValueOnce(new Error('Invalid configuration'));
		const job = await service.createSingleSceneJob(story.id, scenes[0].id, userId);
		await service.processGenerationJob(job.id);
		await prisma.$transaction(tx =>
			(stories as any).syncScenes(tx, story.id, [
				{
					sceneOrder: 1,
					speakerName: 'Narrator',
					text: 'Edited',
					language: 'hi-IN',
					emotion: 'Calm',
					style: 'Narration'
				}
			])
		);
		await expect(service.retryFailedJob(job.id, userId)).rejects.toThrow('changed');
	});

	it('HTTP API requires authentication and hides other users jobs', async () => {
		await request(app.getHttpServer()).get(`/audio-generation/stories/${story.id}/jobs/latest`).expect(401);
		const job = await service.createGenerationJob(story.id, userId);
		await request(app.getHttpServer())
			.get(`/audio-generation/jobs/${job.id}`)
			.auth(jwt.sign({ id: userId + 10000 }), { type: 'bearer' })
			.expect(404);
	});

	it('HTTP create/latest/history/stream/range/ZIP endpoints work together', async () => {
		const created = await request(app.getHttpServer())
			.post(`/audio-generation/stories/${story.id}/jobs`)
			.auth(token, { type: 'bearer' })
			.expect(201);
		await waitFor(async () => (await service.getGenerationJob(created.body.id, userId)).status === 'COMPLETED');
		const latest = await request(app.getHttpServer())
			.get(`/audio-generation/stories/${story.id}/jobs/latest`)
			.auth(token, { type: 'bearer' })
			.expect(200);
		expect(latest.body.status).toBe('COMPLETED');
		const history = await request(app.getHttpServer())
			.get(`/audio-generation/stories/${story.id}/audio-history`)
			.auth(token, { type: 'bearer' })
			.expect(200);
		const audioId = history.body.scenes[0].latestAudio.id;
		await request(app.getHttpServer())
			.get(`/audio-generation/audio/${audioId}/stream`)
			.auth(token, { type: 'bearer' })
			.expect(200)
			.expect('Content-Type', /audio\/wav/)
			.expect('Content-Length', String(wav.length));
		await request(app.getHttpServer())
			.get(`/audio-generation/audio/${audioId}/stream`)
			.auth(token, { type: 'bearer' })
			.set('Range', 'bytes=0-43')
			.expect(206)
			.expect('Content-Length', '44');
		await request(app.getHttpServer())
			.get(`/audio-generation/stories/${story.id}/download-zip`)
			.auth(token, { type: 'bearer' })
			.expect(200)
			.expect('Content-Type', /application\/zip/);
	});

	it('HTTP concurrent generation requests return one 201 and one 409', async () => {
		tts.generateSpeech.mockImplementation(async () => {
			await new Promise(resolve => setTimeout(resolve, 60));
			return wav;
		});
		const results = await Promise.all([
			request(app.getHttpServer())
				.post(`/audio-generation/stories/${story.id}/jobs`)
				.auth(token, { type: 'bearer' }),
			request(app.getHttpServer())
				.post(`/audio-generation/stories/${story.id}/jobs`)
				.auth(token, { type: 'bearer' })
		]);
		expect(results.map(result => result.status).sort()).toEqual([201, 409]);
		const job = results.find(result => result.status === 201)!.body;
		await waitFor(async () => (await service.getGenerationJob(job.id, userId)).status === 'COMPLETED');
	});
	it('cancels pending jobs idempotently and never calls the provider', async () => {
		const j = await service.createGenerationJob(story.id, userId);
		await expect(service.cancelGenerationJob(j.id, userId + 99999)).rejects.toThrow();
		const cancelled = await service.cancelGenerationJob(j.id, userId);
		expect(cancelled.status).toBe('CANCELLED');
		expect(cancelled.items.every(i => i.status === 'CANCELLED' && i.nextRetryAt === null)).toBe(true);
		expect((await service.cancelGenerationJob(j.id, userId)).status).toBe('CANCELLED');
		await service.processGenerationJob(j.id);
		expect(tts.generateSpeech).not.toHaveBeenCalled();
		expect((await service.createGenerationJob(story.id, userId)).status).toBe('PENDING');
	});
	it('cancels during a provider call, preserves saved audio and fences late results', async () => {
		let finish!: (v: typeof wav) => void;
		tts.generateSpeech.mockResolvedValueOnce(wav).mockImplementationOnce(
			() =>
				new Promise<typeof wav>(r => {
					finish = r;
				})
		);
		const j = await service.createGenerationJob(story.id, userId);
		const work = service.processGenerationJob(j.id);
		await waitFor(async () => !!finish);
		const response = await request(app.getHttpServer())
			.post(`/audio-generation/jobs/${j.id}/cancel`)
			.set('Authorization', `Bearer ${token}`)
			.expect(201);
		expect(response.body).toMatchObject({ status: 'CANCELLED', completedScenes: 1 });
		finish(wav);
		await work;
		expect((await service.getGenerationJob(j.id, userId)).status).toBe('CANCELLED');
		expect(await prisma.sceneAudio.count({ where: { scene: { storyId: story.id } } })).toBe(1);
		expect(tts.generateSpeech).toHaveBeenCalledTimes(2);
	});
	it('cancelled quota-wait jobs are not resumed by recovery', async () => {
		tts.generateSpeech.mockRejectedValue(new ProviderRateLimitError('Quota', new Date(Date.now() + 60000)));
		const j = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(j.id);
		expect((await service.getGenerationJob(j.id, userId)).status).toBe('WAITING');
		await service.cancelGenerationJob(j.id, userId);
		tts.generateSpeech.mockClear();
		await service.processGenerationJob(j.id);
		expect(tts.generateSpeech).not.toHaveBeenCalled();
	});
	it('cannot cancel another user job via HTTP or change a completed job', async () => {
		const j = await service.createGenerationJob(story.id, userId);
		await request(app.getHttpServer()).post(`/audio-generation/jobs/${j.id}/cancel`).expect(401);
		await request(app.getHttpServer())
			.post(`/audio-generation/jobs/${j.id}/cancel`)
			.set('Authorization', `Bearer ${jwt.sign({ id: userId + 99999 })}`)
			.expect(404);
		await service.processGenerationJob(j.id);
		expect((await service.cancelGenerationJob(j.id, userId)).status).toBe('COMPLETED');
	});
	it('single voice cancellation fences late audio and preserves the previous asset', async () => {
		const project = await single.create(userId, 'Cancel narration', 'Short script');
		await single.generate(project.id, userId, voice.id);
		await waitFor(async () => (await single.get(project.id, userId)).status === 'SINGLE_COMPLETED');
		const previous = (await single.get(project.id, userId)).audio!.id;
		let finish!: (v: typeof wav) => void;
		tts.generateSpeech.mockImplementationOnce(
			() =>
				new Promise<typeof wav>(r => {
					finish = r;
				})
		);
		await single.generate(project.id, userId, voice.id);
		await waitFor(async () => !!finish);
		await request(app.getHttpServer())
			.post(`/audio-generation/single/stories/${project.id}/cancel`)
			.set('Authorization', `Bearer ${token}`)
			.expect(201);
		finish(wav);
		await new Promise(r => setTimeout(r, 100));
		expect(await single.get(project.id, userId)).toMatchObject({
			status: 'SINGLE_CANCELLED',
			audio: { id: previous }
		});
		await expect(single.cancel(project.id, userId + 99999)).rejects.toThrow();
	});
	it('history exposes assigned voices before any audio is generated', async () => {
		const history = await service.getStoryAudioHistory(story.id, userId);
		expect(history.scenes).toHaveLength(2);
		for (const scene of history.scenes) {
			expect(scene.assignedVoice).toEqual({ id: voice.id, name: voice.name });
			expect(scene.latestAudio).toBeNull();
		}
		await prisma.audioCharacter.updateMany({ where: { storyId: story.id }, data: { voiceId: null } });
		expect((await service.getStoryAudioHistory(story.id, userId)).scenes[0].assignedVoice).toBeNull();
	});
	it('history resolves scene voice overrides before character voices', async () => {
		await prisma.audioCharacter.updateMany({ where: { storyId: story.id }, data: { voiceId: null } });
		await prisma.audioScene.update({ where: { id: scenes[0].id }, data: { voiceOverrideId: voice.id } });
		const history = await service.getStoryAudioHistory(story.id, userId);
		expect(history.scenes[0].assignedVoice).toEqual({ id: voice.id, name: voice.name });
		expect(history.scenes[1].assignedVoice).toBeNull();
	});
	it('uses ordered Hindi titles consistently in history, individual downloads and ZIP', async () => {
		await prisma.audioScene.update({ where: { id: scenes[0].id }, data: { title: 'नौकरी छोड़ने की चिंता' } });
		const j = await service.createGenerationJob(story.id, userId);
		await service.processGenerationJob(j.id);
		const history = await service.getStoryAudioHistory(story.id, userId);
		expect(history.scenes[0].downloadFilename).toBe('001_नौकरी_छोड़ने_की_चिंता.wav');
		expect(history.scenes[1].downloadFilename.startsWith('002_')).toBe(true);
		const audio = await service.getAudioFile(history.scenes[0].latestAudio!.id, userId);
		expect(audio.filename).toBe(history.scenes[0].downloadFilename);
		const zip = await service.downloadStoryAudioZip(story.id, userId);
		const bytes = await collect(zip.stream);
		expect(bytes.includes(Buffer.from(history.scenes[0].downloadFilename))).toBe(true);
		expect(bytes.includes(Buffer.from(history.scenes[1].downloadFilename))).toBe(true);
	});
	it('sanitizes filenames, preserves Hindi marks, and limits UTF-8 length', () => {
		expect(sceneDownloadFilename(7, '../नौकरी / छोड़ने : की चिंता')).toBe('007_नौकरी_छोड़ने_की_चिंता.wav');
		expect(sceneDownloadFilename(2, null, 'घर लौटने की वजह')).toBe('002_घर_लौटने_की_वजह.wav');
		expect(sceneDownloadFilename(3, '!!!', '')).toBe('003_scene.wav');
		expect(sceneDownloadFilename(1000, 'नई योजना')).toBe('1000_नई_योजना.wav');
		expect(Buffer.byteLength(sceneDownloadFilename(1, 'कि'.repeat(200)))).toBeLessThan(200);
	});
});
