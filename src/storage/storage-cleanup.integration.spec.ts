import { AppSettingsService } from '../settings/app-settings.service.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { StorageService } from './storage.service.js';
import { StorageObjectsService, STORAGE_GRACE_MS } from './storage-objects.service.js';
import { StorageCleanupService } from './storage-cleanup.service.js';
const url = process.env.AUDIO_FLOW_TEST_DATABASE_URL;
if (url && (!['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')))
	throw new Error('Disposable local test DB required');
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>(r => {
		resolve = r;
	});
	return { promise, resolve };
};
describe.skipIf(!url)('durable storage cleanup with PostgreSQL locks', () => {
	const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
	const files = new Map<string, Buffer>();
	const adapter = {
		upload: vi.fn(async (input: { key: string; buffer: Buffer }) => {
			files.set(input.key, input.buffer);
			return input.key;
		}),
		delete: vi.fn(async (key: string) => {
			files.delete(key);
		})
	};
	const config = new ConfigService({ STORAGE_PROVIDER: 'local' });
	const objects = new StorageObjectsService(db as any);
	const storage = new StorageService(config, adapter as any, adapter as any, adapter as any, objects);
	const worker = new StorageCleanupService(db as any, storage, new AppSettingsService(db as any, config));
	let userId: number, storyId: number, voiceId: number;
	const key = () => `audio-stories/multiple-voice/story_${storyId}_fixture/exports/export-${randomUUID()}/audio.wav`;
	const upload = (path = key()) =>
		storage.upload({ key: path, buffer: Buffer.from('fixture-audio'), contentType: 'audio/wav' });
	const expire = (location: string) =>
		db.storageObject.update({ where: { location }, data: { nextCleanupAt: new Date(0) } });
	beforeAll(async () => {
		await db.$connect();
		userId = (await db.user.create({ data: { email: `cleanup-${randomUUID()}@example.test` } })).id;
		voiceId = (
			await db.voice.create({
				data: { name: 'Cleanup fixture', provider: 'GEMINI', providerVoiceId: randomUUID(), model: 'fixture' }
			})
		).id;
	});
	beforeEach(async () => {
		await db.storageObject.deleteMany();
		await db.audioGenerationJob.deleteMany({ where: { userId } });
		await db.audioStory.deleteMany({ where: { userId } });
		files.clear();
		config.set('STORAGE_PROVIDER', 'local');
		adapter.upload.mockReset();
		adapter.delete.mockReset();
		adapter.upload.mockImplementation(async input => {
			files.set(input.key, input.buffer);
			return input.key;
		});
		adapter.delete.mockImplementation(async key => {
			files.delete(key);
		});
		storyId = (await db.audioStory.create({ data: { userId, title: 'Fixture', content: 'Fixture' } })).id;
	});
	afterAll(async () => {
		worker.onModuleDestroy();
		await db.storageObject.deleteMany();
		await db.audioGenerationJob.deleteMany({ where: { userId } });
		await db.audioStory.deleteMany({ where: { userId } });
		if (userId) await db.user.delete({ where: { id: userId } });
		if (voiceId) await db.voice.delete({ where: { id: voiceId } });
		await db.$disconnect();
	});
	it('honors the saved cleanup switch before scanning and between objects', async () => {
		const settings = new AppSettingsService(db as any, config);
		const first = await upload(),
			second = await upload();
		await expire(first);
		await expire(second);
		await settings.updateSection('storage', { cleanupEnabled: false });
		try {
			expect((await worker.runOnce()).deleted).toBe(0);
			expect(adapter.delete).not.toHaveBeenCalled();
			await settings.updateSection('storage', { cleanupEnabled: true });
			adapter.delete.mockImplementationOnce(async key => {
				files.delete(key);
				await settings.updateSection('storage', { cleanupEnabled: false });
			});
			expect((await worker.runOnce()).deleted).toBe(1);
			expect(files.size).toBe(1);
			expect((await worker.runOnce()).deleted).toBe(0);
			await settings.updateSection('storage', { cleanupEnabled: true });
			expect((await worker.runOnce()).deleted).toBe(1);
		} finally {
			await settings.updateSection('storage', { cleanupEnabled: null });
		}
	});
	it('protects young uploads, expires only tracked orphans, and leaves existing files/folders untouched', async () => {
		const path = key(),
			location = await upload(path);
		files.set('audio-stories/multiple-voice/', Buffer.alloc(0));
		files.set('audio-stories/legacy.wav', Buffer.from('legacy'));
		expect(
			(await db.storageObject.findUniqueOrThrow({ where: { location } })).nextCleanupAt.getTime()
		).toBeGreaterThan(Date.now() + STORAGE_GRACE_MS - 5000);
		expect((await worker.runOnce()).deleted).toBe(0);
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(1);
		expect(files.has(path)).toBe(false);
		expect(files.has('audio-stories/legacy.wav')).toBe(true);
		expect(files.has('audio-stories/multiple-voice/')).toBe(true);
		expect((await db.storageObject.findUniqueOrThrow({ where: { location } })).status).toBe('DELETED');
		await expect(db.$transaction(tx => storage.confirmUpload(tx, location))).rejects.toMatchObject({ status: 409 });
	});
	it('preserves saved audio/history and collects it only after its reference is removed', async () => {
		const location = await upload();
		const asset = await db.$transaction(async tx => {
			await storage.confirmUpload(tx, location);
			return tx.audioAsset.create({ data: { storyId, type: 'SINGLE_VOICE', filePath: location } });
		});
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(0);
		expect(adapter.delete).not.toHaveBeenCalled();
		await db.audioAsset.delete({ where: { id: asset.id } });
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(1);
	});
	it('preserves scene history independently of whether it is the latest recording', async () => {
		const location = await upload();
		const scene = await db.audioScene.create({ data: { storyId, sceneOrder: 1, text: 'Fixture' } });
		await db.$transaction(async tx => {
			await storage.confirmUpload(tx, location);
			await tx.sceneAudio.create({
				data: {
					sceneId: scene.id,
					voiceId,
					provider: 'GEMINI',
					providerVoiceId: 'fixture',
					model: 'fixture',
					textSnapshot: 'Old recording',
					filePath: location
				}
			});
		});
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(0);
		expect(adapter.delete).not.toHaveBeenCalled();
	});
	it.each(['local', 'supabase', 'r2'])(
		'collects tracked %s files independently of the current writer',
		async provider => {
			config.set('SUPABASE_URL', 'https://fixture.supabase.co');
			config.set('SUPABASE_SERVICE_ROLE_KEY', 'fixture');
			config.set('R2_ENDPOINT', 'https://fixture.r2.cloudflarestorage.com');
			config.set('R2_STORAGE_BUCKET', 'fixture');
			config.set('R2_ACCESS_KEY_ID', 'fixture');
			config.set('R2_SECRET_ACCESS_KEY', 'fixture');
			config.set('STORAGE_PROVIDER', provider);
			const location = await upload();
			expect(location.startsWith(provider + '://')).toBe(true);
			config.set('STORAGE_PROVIDER', provider === 'local' ? 'r2' : 'local');
			await expire(location);
			expect((await worker.runOnce()).deleted).toBe(1);
		}
	);
	it('preserves pending/waiting multi-scene jobs and active single-voice work', async () => {
		const location = await upload();
		const job = await db.audioGenerationJob.create({ data: { storyId, userId, status: 'WAITING' } });
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(0);
		await db.audioGenerationJob.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });
		await db.audioStory.update({ where: { id: storyId }, data: { status: 'SINGLE_PROCESSING' } });
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(0);
		await db.audioStory.update({ where: { id: storyId }, data: { status: 'DRAFT' } });
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(1);
	});
	it('expires tracked temp files and defers unknown future module prefixes', async () => {
		const temp = await upload(`temp/${randomUUID()}/sample.wav`),
			future = await upload(`images/${randomUUID()}.png`);
		await expire(temp);
		await expire(future);
		expect((await worker.runOnce()).deleted).toBe(1);
		expect((await db.storageObject.findUniqueOrThrow({ where: { location: future } })).status).toBe('AVAILABLE');
	});
	it('does not claim or delete an existing untracked object after a no-overwrite rejection', async () => {
		const path = key();
		files.set(path, Buffer.from('pre-existing manual file'));
		adapter.upload.mockRejectedValueOnce(Object.assign(new Error('File already exists'), { code: 'EEXIST' }));
		await expect(upload(path)).rejects.toThrow('already exists');
		const location = 'local://' + path;
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(0);
		expect(files.get(path)!.toString()).toBe('pre-existing manual file');
		expect((await db.storageObject.findUniqueOrThrow({ where: { location } })).status).toBe('UNOWNED');
	});
	it('retains upload receipts on uncertain failures and retries failed deletions after restart', async () => {
		const path = key();
		adapter.upload.mockImplementationOnce(async input => {
			files.set(input.key, input.buffer);
			throw new Error('Upload outcome unknown');
		});
		await expect(upload(path)).rejects.toThrow('outcome unknown');
		const location = 'local://' + path;
		await expire(location);
		adapter.delete.mockRejectedValueOnce(new Error('Storage unavailable'));
		expect((await worker.runOnce()).deleted).toBe(0);
		expect((await db.storageObject.findUniqueOrThrow({ where: { location } })).status).toBe('DELETING');
		await expire(location);
		const restarted = new StorageCleanupService(db as any, storage, new AppSettingsService(db as any, config));
		expect((await restarted.runOnce()).deleted).toBe(1);
		restarted.onModuleDestroy();
	});
	it('never deletes objects from a changed provider namespace', async () => {
		const location = await upload();
		await db.storageObject.update({
			where: { location },
			data: { scope: 'different-host-or-bucket', nextCleanupAt: new Date(0) }
		});
		expect((await worker.runOnce()).deleted).toBe(0);
		expect(adapter.delete).not.toHaveBeenCalled();
	});
	it('lets a committing writer win the lock without deleting the newly attached object', async () => {
		const location = await upload();
		await expire(location);
		const locked = deferred(),
			release = deferred();
		const commit = db.$transaction(
			async tx => {
				await storage.confirmUpload(tx, location);
				locked.resolve();
				await release.promise;
				await tx.audioAsset.create({ data: { storyId, type: 'COMBINED_AUDIO', filePath: location } });
			},
			{ timeout: 10000 }
		);
		await locked.promise;
		try {
			expect((await worker.runOnce()).deleted).toBe(0);
		} finally {
			release.resolve();
			await commit;
		}
		expect((await worker.runOnce()).deleted).toBe(0);
		expect(adapter.delete).not.toHaveBeenCalled();
	});
	it('fences a late reference after cleanup claims the object, including from another worker', async () => {
		const location = await upload();
		await expire(location);
		const deleting = deferred(),
			release = deferred();
		adapter.delete.mockImplementationOnce(async path => {
			deleting.resolve();
			await release.promise;
			files.delete(path);
		});
		const cleanup = worker.runOnce();
		await deleting.promise;
		try {
			await expect(db.$transaction(tx => storage.confirmUpload(tx, location))).rejects.toMatchObject({
				status: 409
			});
			const second = new StorageCleanupService(db as any, storage, new AppSettingsService(db as any, config));
			expect((await second.runOnce()).deleted).toBe(0);
			second.onModuleDestroy();
		} finally {
			release.resolve();
			await cleanup;
		}
		expect(adapter.delete).toHaveBeenCalledTimes(1);
	});
	it('does not let an old deletion acknowledgement erase a failed late-upload cleanup retry', async () => {
		const path = `temp/${randomUUID()}/late-retry.wav`;
		const started = deferred(),
			finishUpload = deferred(),
			firstDeleted = deferred(),
			acknowledge = deferred();
		adapter.upload.mockImplementationOnce(async input => {
			started.resolve();
			await finishUpload.promise;
			files.set(input.key, input.buffer);
			return input.key;
		});
		adapter.delete
			.mockImplementationOnce(async file => {
				files.delete(file);
				firstDeleted.resolve();
				await acknowledge.promise;
			})
			.mockRejectedValueOnce(new Error('Late delete failed'));
		const pending = upload(path),
			rejected = expect(pending).rejects.toThrow('Late delete failed');
		await started.promise;
		const location = 'local://' + path;
		await expire(location);
		const cleanup = worker.runOnce();
		await firstDeleted.promise;
		finishUpload.resolve();
		await rejected;
		acknowledge.resolve();
		await cleanup;
		expect(files.has(path)).toBe(true);
		expect((await db.storageObject.findUniqueOrThrow({ where: { location } })).status).toBe('DELETING');
		await expire(location);
		expect((await worker.runOnce()).deleted).toBe(1);
		expect(files.has(path)).toBe(false);
	});
	it('removes an upload that finishes after collection rather than resurrecting a deleted object', async () => {
		const path = `temp/${randomUUID()}/late.wav`,
			started = deferred(),
			release = deferred();
		adapter.upload.mockImplementationOnce(async input => {
			started.resolve();
			await release.promise;
			files.set(input.key, input.buffer);
			return input.key;
		});
		const pending = upload(path);
		const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
		await started.promise;
		await expire('local://' + path);
		expect((await worker.runOnce()).deleted).toBe(1);
		release.resolve();
		await rejected;
		expect(files.has(path)).toBe(false);
		expect((await db.storageObject.findUniqueOrThrow({ where: { location: 'local://' + path } })).status).toBe(
			'DELETING'
		);
	});
});
