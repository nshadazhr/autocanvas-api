import type { Readable } from 'node:stream';

export type StorageProvider = 'local' | 'supabase' | 'r2';

export interface StorageUploadOptions {
	key: string;
	buffer: Buffer;
	contentType: string;
}

export interface StorageFile {
	stream: Readable;
	size: number;
	contentType: string;
}

export interface StorageReadOptions {
	start?: number;
	end?: number;
}

export interface StorageAdapter {
	upload(options: StorageUploadOptions): Promise<string>;

	getFile(key: string, options?: StorageReadOptions): Promise<StorageFile>;

	delete(key: string): Promise<void>;

	getMetadata(key: string): Promise<StorageMetadata>;
}

export interface StorageMetadata {
	size: number;
	contentType: string;
}
