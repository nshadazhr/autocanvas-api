import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service.js';
import { LocalStorageProvider } from './providers/local-storage.provider.js';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider.js';
import {
	attachment,
	ownedExportKey,
	storageLabel,
	storyDownloadName,
	storyFolder
} from '../audio-generation/utils/audio-storage-names.js';
const remote = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('@supabase/supabase-js', () => ({
	createClient: () => ({
		storage: {
			from: () => ({
				upload: async (key: string, buffer: Buffer, options: { upsert: boolean }) => {
					if (!/^[A-Za-z0-9_./-]+$/.test(key)) return { error: { message: 'InvalidKey' } };
					if (remote.has(key) && !options.upsert) return { error: { message: 'Already exists' } };
					remote.set(key, buffer);
					return { error: null };
				},
				download: async (key: string) => ({
					data: remote.has(key) ? new Blob([Uint8Array.from(remote.get(key)!)]) : null,
					error: null
				}),
				info: async (key: string) => ({
					data: remote.has(key) ? { size: remote.get(key)!.length, contentType: 'audio/wav' } : null,
					error: null
				}),
				remove: async (keys: string[]) => {
					for (const key of keys) remote.delete(key);
					return { error: null };
				}
			})
		}
	})
}));
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	remote.clear();
	await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
describe('Provider-independent audio layout', () => {
	it('uses readable safe Roman keys, stable story identity and title-less fallbacks', () => {
		expect(storyFolder(54, 'गांव में फ्रेंच फ्राइज')).toMatch(
			/^audio-stories\/multiple-voice\/story_54_[A-Za-z0-9_]+$/
		);
		expect(storyFolder(55, undefined, true)).toBe('audio-stories/single-voice/story_55_untitled');
		expect(storageLabel('../../bad\npath', 'audio')).toBe('bad_path');
		expect(storyDownloadName(54, 'गांव में फ्रेंच फ्राइज')).toBe('गांव_में_फ्रेंच_फ्राइज');
		expect(storyDownloadName(55, 'Untitled Audio')).toBe('story_55_audio');
		expect(attachment('मेरी_कहानी.zip')).toContain("filename*=UTF-8''%E0");
	});
	it('authorizes old and new exports by exact story ID independently of renamed titles', () => {
		expect(ownedExportKey('local://audio-stories/54/exports/old.wav', 54)).toBe(true);
		expect(ownedExportKey('uploads/audio-stories/54/exports/old.wav', 54)).toBe(true);
		expect(
			ownedExportKey(
				'supabase://audio-stories/multiple-voice/story_54_old_title/exports/export-a8f2/story.wav',
				54
			)
		).toBe(true);
		for (const key of [
			'audio-stories/540/exports/a.wav',
			'audio-stories/54/exports/../secret.wav',
			'audio-stories/multiple-voice/story_55_other/exports/export-ab/file.wav'
		])
			expect(ownedExportKey(key, 54)).toBe(false);
	});
	it('writes identical logical keys through real local and mocked Supabase adapters and reads historical locations after switching', async () => {
		const root = await mkdtemp(join(tmpdir(), 'autocanvas-layout-'));
		roots.push(root);
		vi.spyOn(process, 'cwd').mockReturnValue(root);
		const config = new ConfigService({
			STORAGE_PROVIDER: 'local',
			SUPABASE_URL: 'https://fixture.supabase.co',
			SUPABASE_SERVICE_ROLE_KEY: 'fixture-only'
		});
		const local = new LocalStorageProvider();
		const service = new StorageService(config, local, new SupabaseStorageProvider(config));
		const key = storyFolder(54, 'गांव में फ्रेंच फ्राइज') + '/job-40/take-a8f2/001_scene.wav';
		const options = { key, buffer: Buffer.from('RIFF-test-audio'), contentType: 'audio/wav' };
		const disk = await service.upload(options);
		config.set('STORAGE_PROVIDER', 'supabase');
		const cloud = await service.upload(options);
		expect(disk).toBe('local://' + key);
		expect(cloud).toBe('supabase://' + key);
		for (const path of [disk, cloud]) {
			const file = await service.getFile(path, { start: 0, end: 3 });
			const chunks: Buffer[] = [];
			for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
			expect(Buffer.concat(chunks).toString()).toBe('RIFF');
			expect((await service.getMetadata(path)).size).toBe(options.buffer.length);
		}
		await expect(service.upload(options)).rejects.toThrow('Already exists');
		config.set('STORAGE_PROVIDER', 'local');
		await expect(service.upload(options)).rejects.toThrow();
		await local.upload({ ...options, key: 'audio-stories/54/old.wav' });
		expect((await service.getMetadata('uploads/audio-stories/54/old.wav')).size).toBe(options.buffer.length);
		await service.delete(disk);
		await service.delete(cloud);
	});
});
