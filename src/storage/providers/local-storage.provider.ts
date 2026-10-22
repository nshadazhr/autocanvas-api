import { Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';

import type {
	StorageAdapter,
	StorageUploadOptions,
	StorageFile,
	StorageReadOptions,
	StorageMetadata
} from '../storage.interface.js';

@Injectable()
export class LocalStorageProvider implements StorageAdapter {
	private readonly root = resolve(process.cwd(), 'uploads');

	private resolvePath(key: string): string {
		const absolutePath = resolve(this.root, key);
		const relativePath = relative(this.root, absolutePath);

		if (!key || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error('Invalid storage key');
		}

		return absolutePath;
	}

	async upload(options: StorageUploadOptions): Promise<string> {
		const absolutePath = this.resolvePath(options.key);

		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, options.buffer, { flag: 'wx' });

		return options.key;
	}

	async getFile(key: string, options?: StorageReadOptions): Promise<StorageFile> {
		const absolutePath = this.resolvePath(key);

		let fileStat;

		try {
			fileStat = await stat(absolutePath);
		} catch {
			throw new NotFoundException('File not found');
		}

		if (!fileStat.isFile()) {
			throw new NotFoundException('File not found');
		}

		const stream = createReadStream(absolutePath, {
			...(options?.start !== undefined ? { start: options.start } : {}),
			...(options?.end !== undefined ? { end: options.end } : {})
		});

		return {
			stream,
			size: fileStat.size,
			contentType: 'application/octet-stream'
		};
	}

	async delete(key: string): Promise<void> {
		const absolutePath = this.resolvePath(key);

		await rm(absolutePath, { force: true });
	}

	async getMetadata(key: string): Promise<StorageMetadata> {
		const absolutePath = this.resolvePath(key);

		try {
			const fileStat = await stat(absolutePath);

			if (!fileStat.isFile()) {
				throw new NotFoundException('File not found');
			}

			return {
				size: fileStat.size,
				contentType: 'application/octet-stream'
			};
		} catch (error) {
			if (error instanceof NotFoundException) {
				throw error;
			}

			throw new NotFoundException('File not found');
		}
	}
}
