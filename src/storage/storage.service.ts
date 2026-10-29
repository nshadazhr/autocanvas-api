import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { StorageObjectsService } from './storage-objects.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { BadRequestException, Injectable, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LocalStorageProvider } from './providers/local-storage.provider.js';
import { R2StorageProvider } from './providers/r2-storage.provider.js';
import { SupabaseStorageProvider } from './providers/supabase-storage.provider.js';

import type {
	StorageAdapter,
	StorageUploadOptions,
	StorageReadOptions,
	StorageFile,
	StorageMetadata
} from './storage.interface.js';

@Injectable()
export class StorageService {
	constructor(
		private readonly configService: ConfigService,
		private readonly localStorage: LocalStorageProvider,
		private readonly supabaseStorage: SupabaseStorageProvider,
		private readonly r2Storage: R2StorageProvider,
		private readonly objects: StorageObjectsService
	) {}

	private getProvider(name: string): StorageAdapter {
		switch (name) {
			case 'local':
				return this.localStorage;

			case 'r2':
				return this.r2Storage;

			case 'supabase':
				return this.supabaseStorage;

			default:
				throw new BadRequestException(`Unsupported storage provider: ${name}`);
		}
	}

	private getActiveProvider(): string {
		return (this.configService.get<string>('STORAGE_PROVIDER') || 'local').trim().toLowerCase();
	}

	private parseLocation(location: string): {
		provider: string;
		key: string;
	} {
		const match = /^(local|supabase|r2):\/\/(.+)$/.exec(location ?? '');
		if (
			!match ||
			/[\\\x00-\x1f\x7f]/.test(match[2]) ||
			match[2].split('/').some(part => !part || part === '.' || part === '..')
		)
			throw new BadRequestException('Invalid storage location');
		return { provider: match[1], key: match[2] };
	}

	cleanupScope(location: string): string | null {
		const { provider } = this.parseLocation(location);
		let identity: string;
		if (provider === 'local') identity = hostname() + ':' + resolve(process.cwd(), 'autocanvas-assets');
		else if (provider === 'supabase') {
			if (!this.configService.get('SUPABASE_URL') || !this.configService.get('SUPABASE_SERVICE_ROLE_KEY'))
				return null;
			identity =
				this.configService.get<string>('SUPABASE_URL')!.trim() +
				'/' +
				(this.configService.get<string>('SUPABASE_STORAGE_BUCKET') || 'autocanvas-assets');
		} else {
			if (
				!['R2_ENDPOINT', 'R2_STORAGE_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].every(key =>
					this.configService.get<string>(key)?.trim()
				)
			)
				return null;
			identity =
				this.configService.get<string>('R2_ENDPOINT')!.trim() +
				'/' +
				this.configService.get<string>('R2_STORAGE_BUCKET')!.trim();
		}
		return createHash('sha256')
			.update(provider + ':' + identity)
			.digest('hex');
	}

	async confirmUpload(tx: Prisma.TransactionClient, location: string) {
		await this.objects.confirm(tx, location);
	}

	async upload(options: StorageUploadOptions): Promise<string> {
		if (
			!options.key ||
			options.key.startsWith('/') ||
			/[\\\x00-\x1f\x7f]/.test(options.key) ||
			options.key.split('/').some(part => !part || part === '.' || part === '..')
		)
			throw new BadRequestException('Invalid storage key');
		const provider = this.getActiveProvider();
		const adapter = this.getProvider(provider);
		const key = options.key;
		const location = `${provider}://${key}`;
		const scope = this.cleanupScope(location);
		if (!scope) throw new InternalServerErrorException('Storage provider is not configured');
		const object = await this.objects.begin(location, scope);
		try {
			await adapter.upload({ ...options, key });
		} catch (error) {
			const failure = error as { code?: string; status?: number; message?: string };
			// A rejected no-overwrite attempt does not establish ownership of an existing object.
			if (
				failure?.code === 'EEXIST' ||
				failure?.status === 409 ||
				failure?.status === 412 ||
				/already exists/i.test(failure?.message ?? '')
			)
				await this.objects.unowned(object.id);
			throw error;
		}
		if (!(await this.objects.ready(object.id))) {
			// The upload completed after collection began; remove a possible late remote write.
			await this.objects.deferDeletion(object.id);
			await adapter.delete(key);
			throw new ConflictException('Upload expired before it could be saved');
		}
		return location;
	}

	async getFile(location: string, options?: StorageReadOptions): Promise<StorageFile> {
		const { provider, key } = this.parseLocation(location);

		return this.getProvider(provider).getFile(key, options);
	}

	async delete(location: string): Promise<void> {
		const { provider, key } = this.parseLocation(location);

		await this.getProvider(provider).delete(key);
	}

	async getMetadata(location: string): Promise<StorageMetadata> {
		const { provider, key } = this.parseLocation(location);

		return this.getProvider(provider).getMetadata(key);
	}
}
