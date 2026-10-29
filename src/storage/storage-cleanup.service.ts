import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from './storage.service.js';
import { STORAGE_CLEANUP_INTERVAL_MS, STORAGE_CLEANUP_POLL_MS, STORAGE_GRACE_MS } from './storage-objects.service.js';

@Injectable()
export class StorageCleanupService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(StorageCleanupService.name);
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = true;
	private running = false;
	private nextScanAt = 0;
	constructor(
		private readonly prisma: PrismaService,
		private readonly storage: StorageService,
		private readonly settings: AppSettingsService
	) {}

	onModuleInit() {
		this.stopped = false;
		this.schedule(STORAGE_CLEANUP_POLL_MS);
	}
	private schedule(delay: number) {
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.runOnce(true)
				.catch(() => this.logger.error('Storage cleanup scan failed; it will retry'))
				.finally(() => this.schedule(STORAGE_CLEANUP_POLL_MS));
		}, delay);
		this.timer.unref?.();
	}
	onModuleDestroy() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private async enabled() {
		const { values } = await this.settings.section('storage');
		if (typeof values.cleanupEnabled !== 'boolean') throw new Error('Invalid storage cleanup setting');
		return values.cleanupEnabled;
	}

	async runOnce(scheduled = false) {
		if (this.running) return { deleted: 0 };
		this.running = true;
		const lifecycleRun = !this.stopped;
		let deleted = 0;
		try {
			if (!(await this.enabled())) {
				this.nextScanAt = 0;
				return { deleted: 0 };
			}
			if (scheduled && Date.now() < this.nextScanAt) return { deleted: 0 };
			const candidates = await this.prisma.storageObject.findMany({
				where: { status: { in: ['UPLOADING', 'AVAILABLE', 'DELETING'] }, nextCleanupAt: { lte: new Date() } },
				orderBy: [{ nextCleanupAt: 'asc' }, { id: 'asc' }],
				take: 100
			});
			for (const candidate of candidates) {
				if (lifecycleRun && this.stopped) break;
				if (!(await this.enabled())) {
					this.nextScanAt = 0;
					return { deleted };
				}
				try {
					const currentScope = this.storage.cleanupScope(candidate.location);
					if (!currentScope || currentScope !== candidate.scope) {
						await this.prisma.storageObject.updateMany({
							where: { id: candidate.id, nextCleanupAt: { lte: new Date() } },
							data: { nextCleanupAt: new Date(Date.now() + STORAGE_CLEANUP_INTERVAL_MS) }
						});
						continue;
					}
					const target = await this.prisma.$transaction(async tx => {
						const locked = await tx.$queryRaw<
							Array<{ id: string }>
						>`SELECT id FROM "StorageObject" WHERE id = ${candidate.id} FOR UPDATE SKIP LOCKED`;
						if (!locked.length) return null;
						const row = await tx.storageObject.findUnique({ where: { id: candidate.id } });
						if (!row || row.status === 'DELETED' || row.nextCleanupAt > new Date()) return null;
						const key = row.location.replace(/^(local|supabase|r2):\/\//, '');
						// Unknown future modules need their own reference resolver before collection is allowed.
						if (!key.startsWith('audio-stories/') && !key.startsWith('temp/')) {
							await tx.storageObject.update({
								where: { id: row.id },
								data: { nextCleanupAt: new Date(Date.now() + STORAGE_GRACE_MS) }
							});
							return null;
						}
						const references = await Promise.all([
							tx.sceneAudio.count({ where: { filePath: row.location } }),
							tx.audioAsset.count({ where: { filePath: row.location } })
						]);
						const storyMatch = /^audio-stories\/(?:single-voice|multiple-voice)\/story_(\d+)_/.exec(key);
						const storyId = storyMatch ? Number(storyMatch[1]) : null;
						const busy = storyId
							? (await tx.audioGenerationJob.count({
									where: { storyId, status: { in: ['PENDING', 'PROCESSING', 'WAITING'] } }
								})) +
								(await tx.audioStory.count({
									where: { id: storyId, status: { in: ['SINGLE_PENDING', 'SINGLE_PROCESSING'] } }
								}))
							: 0;
						if (references.some(Boolean) || busy) {
							await tx.storageObject.update({
								where: { id: row.id },
								data: { nextCleanupAt: new Date(Date.now() + STORAGE_GRACE_MS) }
							});
							return null;
						}
						// Commit a durable tombstone before network I/O. A late writer cannot attach this object.
						const cleanupToken = randomUUID();
						await tx.storageObject.update({
							where: { id: row.id },
							data: {
								status: 'DELETING',
								cleanupToken,
								nextCleanupAt: new Date(Date.now() + STORAGE_CLEANUP_INTERVAL_MS)
							}
						});
						return { ...row, cleanupToken };
					});
					if (!target) continue;
					await this.storage.delete(target.location);
					const completed = await this.prisma.storageObject.updateMany({
						where: { id: target.id, status: 'DELETING', cleanupToken: target.cleanupToken },
						data: { status: 'DELETED' }
					});
					deleted += completed.count;
				} catch {
					this.logger.warn(`Storage object cleanup deferred: ${candidate.id}`);
				}
			}
			this.nextScanAt = Date.now() + STORAGE_CLEANUP_INTERVAL_MS;
			return { deleted };
		} finally {
			this.running = false;
		}
	}
}
