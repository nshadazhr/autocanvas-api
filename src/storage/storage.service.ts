import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LocalStorageProvider } from './providers/local-storage.provider.js';
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
		private readonly supabaseStorage: SupabaseStorageProvider
	) {}

	private getProvider(name: string): StorageAdapter {
		switch (name) {
			case 'local':
				return this.localStorage;

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
		if (!location) {
			throw new BadRequestException('Invalid storage location');
		}

		const match = /^(local|supabase):\/\/(.+)$/.exec(location);

		if (match) {
			return {
				provider: match[1],
				key: match[2]
			};
		}

		if (location.includes('://')) {
			throw new BadRequestException('Invalid storage location');
		}

		const normalizedPath = location.replace(/\\/g, '/');

		if (!normalizedPath.startsWith('uploads/audio-stories/')) {
			throw new BadRequestException('Invalid legacy storage location');
		}

		return {
			provider: 'local',
			key: normalizedPath.slice('uploads/'.length)
		};
	}

	async upload(options: StorageUploadOptions): Promise<string> {
		const provider = this.getActiveProvider();

		const key = await this.getProvider(provider).upload(options);

		return `${provider}://${key}`;
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
