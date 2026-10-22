import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Readable } from 'node:stream';

import type {
	StorageAdapter,
	StorageUploadOptions,
	StorageFile,
	StorageReadOptions,
	StorageMetadata
} from '../storage.interface.js';

@Injectable()
export class SupabaseStorageProvider implements StorageAdapter {
	private readonly client: SupabaseClient | null;
	private readonly bucket: string;

	constructor(private readonly configService: ConfigService) {
		const url = this.configService.get<string>('SUPABASE_URL');
		const key = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

		this.bucket = this.configService.get<string>('SUPABASE_STORAGE_BUCKET') || 'autocanvas-audio';

		// Local mode mein Supabase credentials required nahi hain.

		this.client =
			url && key
				? createClient(url, key, {
						auth: {
							autoRefreshToken: false,
							persistSession: false
						},
						realtime: {
							transport: WebSocket
						}
					})
				: null;
	}

	private getClient(): SupabaseClient {
		if (!this.client) {
			throw new InternalServerErrorException('Supabase Storage is not configured');
		}

		return this.client;
	}

	async upload(options: StorageUploadOptions): Promise<string> {
		const { error } = await this.getClient().storage.from(this.bucket).upload(options.key, options.buffer, {
			contentType: options.contentType,
			upsert: false
		});

		if (error) {
			throw new InternalServerErrorException(`Supabase upload failed: ${error.message}`);
		}

		return options.key;
	}

	async getFile(key: string, options?: StorageReadOptions): Promise<StorageFile> {
		const { data, error } = await this.getClient().storage.from(this.bucket).download(key);

		if (error || !data) {
			throw new NotFoundException('Storage file not found');
		}

		const buffer = Buffer.from(await data.arrayBuffer());
		const start = options?.start ?? 0;
		const end = options?.end ?? buffer.length - 1;

		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end < start ||
			end >= buffer.length
		) {
			throw new RangeError('Invalid storage range');
		}

		return {
			stream: Readable.from(buffer.subarray(start, end + 1)),
			size: buffer.length,
			contentType: data.type || 'application/octet-stream'
		};
	}

	async delete(key: string): Promise<void> {
		const { error } = await this.getClient().storage.from(this.bucket).remove([key]);

		if (error) {
			throw new InternalServerErrorException(`Supabase delete failed: ${error.message}`);
		}
	}

	async getMetadata(key: string): Promise<StorageMetadata> {
		const { data, error } = await this.getClient().storage.from(this.bucket).info(key);

		if (error || !data) {
			throw new NotFoundException('Storage file not found');
		}

		const size = Number(data.size);

		if (!Number.isSafeInteger(size) || size < 0) {
			throw new InternalServerErrorException('Invalid Supabase file size');
		}

		return {
			size,
			contentType: data.contentType || 'application/octet-stream'
		};
	}
}
