import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export const STORAGE_GRACE_MS = 24 * 60 * 60 * 1000;
export const STORAGE_CLEANUP_POLL_MS = 30000;
export const STORAGE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class StorageObjectsService {
	constructor(private readonly prisma: PrismaService) {}

	async begin(location: string, scope: string) {
		try {
			return await this.prisma.storageObject.create({
				data: { location, scope, status: 'UPLOADING', nextCleanupAt: new Date(Date.now() + STORAGE_GRACE_MS) }
			});
		} catch (error) {
			if ((error as { code?: string })?.code === 'P2002')
				throw new ConflictException('Storage object already exists');
			throw error;
		}
	}

	async deferDeletion(id: string) {
		await this.prisma.storageObject.updateMany({
			where: { id, status: { in: ['DELETING', 'DELETED'] } },
			data: {
				status: 'DELETING',
				cleanupToken: randomUUID(),
				nextCleanupAt: new Date(Date.now() + STORAGE_CLEANUP_INTERVAL_MS)
			}
		});
	}

	async unowned(id: string) {
		await this.prisma.storageObject.updateMany({ where: { id, status: 'UPLOADING' }, data: { status: 'UNOWNED' } });
	}

	async ready(id: string) {
		const result = await this.prisma.storageObject.updateMany({
			where: { id, status: 'UPLOADING' },
			data: { status: 'AVAILABLE', nextCleanupAt: new Date(Date.now() + STORAGE_GRACE_MS) }
		});
		return result.count === 1;
	}

	/** The same row lock fences deletion against all new durable audio references. */
	async confirm(tx: Prisma.TransactionClient, location: string) {
		await tx.$queryRaw`SELECT id FROM "StorageObject" WHERE location = ${location} FOR UPDATE`;
		const object = await tx.storageObject.findUnique({ where: { location } });
		if (!object || object.status !== 'AVAILABLE')
			throw new ConflictException('Uploaded file is no longer available; generate it again');
	}
}
