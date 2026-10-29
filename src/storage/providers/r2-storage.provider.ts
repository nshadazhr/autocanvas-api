import {
	BadRequestException,
	ConflictException,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
	type OnModuleDestroy
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type {
	StorageAdapter,
	StorageFile,
	StorageMetadata,
	StorageReadOptions,
	StorageUploadOptions
} from '../storage.interface.js';

@Injectable()
export class R2StorageProvider implements StorageAdapter, OnModuleDestroy {
	private client: S3Client | null = null;
	private bucket = '';

	constructor(private readonly config: ConfigService) {}

	private store() {
		if (!this.client) {
			const endpoint = this.config.get<string>('R2_ENDPOINT')?.trim();
			const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID')?.trim();
			const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY')?.trim();
			const bucket = this.config.get<string>('R2_STORAGE_BUCKET')?.trim();
			if (!endpoint || !accessKeyId || !secretAccessKey || !bucket)
				throw new InternalServerErrorException('R2 Storage is not configured');
			try {
				const url = new URL(endpoint);
				if (
					url.protocol !== 'https:' ||
					!url.hostname.endsWith('.r2.cloudflarestorage.com') ||
					url.username ||
					url.password ||
					url.pathname !== '/' ||
					url.search ||
					url.hash ||
					url.port
				)
					throw new Error('Invalid endpoint');
			} catch {
				throw new InternalServerErrorException('R2 Storage endpoint must be the Cloudflare HTTPS S3 endpoint');
			}
			this.client = new S3Client({
				region: 'auto',
				endpoint,
				credentials: { accessKeyId, secretAccessKey },
				forcePathStyle: true,
				requestChecksumCalculation: 'WHEN_REQUIRED',
				responseChecksumValidation: 'WHEN_REQUIRED',
				requestHandler: { connectionTimeout: 10000, requestTimeout: 90000 }
			});
			this.bucket = bucket;
		}
		return { client: this.client, bucket: this.bucket };
	}

	private validateKey(key: string) {
		if (
			!key ||
			key.startsWith('/') ||
			/[\\\x00-\x1f\x7f]/.test(key) ||
			key.includes('://') ||
			key.split('/').some(part => !part || part === '.' || part === '..')
		)
			throw new BadRequestException('Invalid storage key');
	}

	private failure(error: unknown): never {
		const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
		const status = failure?.$metadata?.httpStatusCode;
		if (failure?.name === 'NoSuchKey' || failure?.name === 'NotFound' || status === 404)
			throw new NotFoundException('Storage file not found');
		if (failure?.name === 'InvalidRange' || status === 416) throw new RangeError('Invalid storage range');
		if (failure?.name === 'PreconditionFailed' || status === 412)
			throw new ConflictException('Storage file already exists');
		// Do not expose upstream messages, credential details or signed request URLs.
		throw new InternalServerErrorException('R2 Storage operation failed');
	}

	async upload(options: StorageUploadOptions): Promise<string> {
		this.validateKey(options.key);
		const { client, bucket } = this.store();
		try {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: options.key,
					Body: options.buffer,
					ContentType: options.contentType,
					ContentLength: options.buffer.length,
					IfNoneMatch: '*'
				})
			);
		} catch (error) {
			this.failure(error);
		}
		return options.key;
	}

	async getMetadata(key: string): Promise<StorageMetadata> {
		this.validateKey(key);
		const { client, bucket } = this.store();
		let result;
		try {
			result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		} catch (error) {
			this.failure(error);
		}
		const size = result.ContentLength;
		if (!Number.isSafeInteger(size) || size! < 0) throw new InternalServerErrorException('Invalid R2 file size');
		return { size: size!, contentType: result.ContentType || 'application/octet-stream' };
	}

	async getFile(key: string, options?: StorageReadOptions): Promise<StorageFile> {
		this.validateKey(key);
		const ranged = options?.start !== undefined || options?.end !== undefined;
		const start = options?.start ?? 0;
		const end = options?.end;
		if (
			!Number.isSafeInteger(start) ||
			start < 0 ||
			(end !== undefined && (!Number.isSafeInteger(end) || end < start))
		)
			throw new RangeError('Invalid storage range');
		const { client, bucket } = this.store();
		let result;
		try {
			result = await client.send(
				new GetObjectCommand({
					Bucket: bucket,
					Key: key,
					...(ranged ? { Range: `bytes=${start}-${end ?? ''}` } : {})
				})
			);
		} catch (error) {
			this.failure(error);
		}
		if (!(result.Body instanceof Readable)) throw new InternalServerErrorException('Invalid R2 file stream');
		let size = result.ContentLength;
		try {
			if (ranged) {
				const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.ContentRange ?? '');
				if (!match) throw new InternalServerErrorException('Invalid R2 range response');
				const first = Number(match[1]),
					last = Number(match[2]),
					total = Number(match[3]);
				if (
					![first, last, total].every(Number.isSafeInteger) ||
					first !== start ||
					last < first ||
					last >= total ||
					size !== last - first + 1
				)
					throw new InternalServerErrorException('Invalid R2 range response');
				if (end !== undefined && end >= total) throw new RangeError('Invalid storage range');
				if (last !== (end ?? total - 1)) throw new InternalServerErrorException('Invalid R2 range response');
				size = total;
			}
			if (!Number.isSafeInteger(size) || size! < 0)
				throw new InternalServerErrorException('Invalid R2 file size');
		} catch (error) {
			result.Body.destroy();
			throw error;
		}
		return { stream: result.Body, size: size!, contentType: result.ContentType || 'application/octet-stream' };
	}

	async delete(key: string): Promise<void> {
		this.validateKey(key);
		const { client, bucket } = this.store();
		try {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		} catch (error) {
			if ((error as { name?: string })?.name === 'NoSuchKey') return;
			this.failure(error);
		}
	}

	onModuleDestroy() {
		this.client?.destroy();
	}
}
