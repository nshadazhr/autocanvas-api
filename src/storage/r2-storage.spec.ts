import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { R2StorageProvider } from './providers/r2-storage.provider.js';
import { StorageService } from './storage.service.js';
import { ownedExportKey } from '../audio-generation/utils/audio-storage-names.js';
const fixture = {
	R2_ENDPOINT: 'https://fixture.r2.cloudflarestorage.com',
	R2_ACCESS_KEY_ID: 'fixture-access',
	R2_SECRET_ACCESS_KEY: 'fixture-secret',
	R2_STORAGE_BUCKET: 'fixture-audio'
};
const key = 'audio-stories/multiple-voice/story_54_fixture/exports/export-a8f2/audio.wav';
const data = Buffer.from('RIFF-test-audio');
const upload = { key, buffer: data, contentType: 'audio/wav' };
async function bytes(stream: Readable) {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}
const error = (name: string, status: number) =>
	Object.assign(new Error('private signed request detail'), { name, $metadata: { httpStatusCode: status } });
const providers: R2StorageProvider[] = [];
afterEach(() => {
	for (const provider of providers.splice(0)) provider.onModuleDestroy();
	vi.restoreAllMocks();
});
function setup(values: Record<string, string> = fixture) {
	const config = new ConfigService(values);
	const provider = new R2StorageProvider(config);
	providers.push(provider);
	return { provider, config };
}

describe('R2 storage adapter', () => {
	let send: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		send = vi.spyOn(S3Client.prototype, 'send');
	});
	it('uploads without overwrite, streams full/ranged reads with total size, returns metadata and deletes', async () => {
		const objects = new Map<string, Buffer>();
		send.mockImplementation((async (command: any) => {
			const input = command.input;
			expect(input.Bucket).toBe('fixture-audio');
			if (command instanceof PutObjectCommand) {
				expect(input.IfNoneMatch).toBe('*');
				expect(input.ContentType).toBe('audio/wav');
				expect(input.ContentLength).toBe(data.length);
				if (objects.has(input.Key)) throw error('PreconditionFailed', 412);
				objects.set(input.Key, input.Body);
				return {};
			}
			if (command instanceof DeleteObjectCommand) {
				objects.delete(input.Key);
				return {};
			}
			const buffer = objects.get(input.Key);
			if (!buffer) throw error('NoSuchKey', 404);
			if (command instanceof HeadObjectCommand) return { ContentLength: buffer.length, ContentType: 'audio/wav' };
			const range = input.Range && /^bytes=(\d+)-(\d*)$/.exec(input.Range);
			const start = range ? Number(range[1]) : 0,
				end = range?.[2] ? Number(range[2]) : buffer.length - 1;
			return {
				Body: Readable.from(buffer.subarray(start, end + 1)),
				ContentLength: end - start + 1,
				ContentType: 'audio/wav',
				...(range ? { ContentRange: `bytes ${start}-${end}/${buffer.length}` } : {})
			};
		}) as any);
		const { provider } = setup();
		expect(await provider.upload(upload)).toBe(key);
		await expect(provider.upload(upload)).rejects.toMatchObject({ status: 409 });
		expect(await provider.getMetadata(key)).toEqual({ size: data.length, contentType: 'audio/wav' });
		const full = await provider.getFile(key);
		expect(await bytes(full.stream)).toEqual(data);
		expect(full.size).toBe(data.length);
		for (const range of [{ start: 0, end: 3 }, { start: 5 }, { end: 3 }]) {
			const file = await provider.getFile(key, range);
			expect(file.size).toBe(data.length);
			expect(await bytes(file.stream)).toEqual(
				data.subarray(range.start ?? 0, range.end === undefined ? undefined : range.end + 1)
			);
		}
		await provider.delete(key);
		await provider.delete(key);
		await expect(provider.getMetadata(key)).rejects.toMatchObject({ status: 404 });
	});
	it('is optional for local/sandbox startup and fails clearly if used without credentials', async () => {
		const { provider } = setup({});
		await expect(provider.upload(upload)).rejects.toThrow('R2 Storage is not configured');
		await expect(provider.getFile(key)).rejects.toThrow('R2 Storage is not configured');
		expect(send).not.toHaveBeenCalled();
	});
	it.each([
		'http://fixture.r2.cloudflarestorage.com',
		'https://untrusted.example',
		'https://fixture.r2.cloudflarestorage.com/bucket',
		'https://user:secret@fixture.r2.cloudflarestorage.com'
	])('rejects invalid endpoint %s without sending credentials', async endpoint => {
		const { provider } = setup({ ...fixture, R2_ENDPOINT: endpoint });
		await expect(provider.upload(upload)).rejects.toThrow('Cloudflare HTTPS S3 endpoint');
		expect(send).not.toHaveBeenCalled();
	});
	it.each([
		'../secret.wav',
		'/absolute.wav',
		'audio/../secret.wav',
		'audio\\secret.wav',
		'audio//file.wav',
		'audio\nfile.wav'
	])('rejects unsafe key %s before network access', async key => {
		const { provider } = setup();
		await expect(provider.getFile(key)).rejects.toMatchObject({ status: 400 });
		expect(send).not.toHaveBeenCalled();
	});
	it.each([{ start: -1 }, { start: 3, end: 2 }, { start: 0.5 }, { end: Infinity }])(
		'rejects invalid range %j before network access',
		async range => {
			const { provider } = setup();
			await expect(provider.getFile(key, range)).rejects.toBeInstanceOf(RangeError);
			expect(send).not.toHaveBeenCalled();
		}
	);
	it('maps missing files/range errors and sanitizes permission/network errors', async () => {
		const { provider } = setup();
		send.mockRejectedValueOnce(error('NoSuchKey', 404));
		await expect(provider.getFile(key)).rejects.toMatchObject({ status: 404 });
		send.mockRejectedValueOnce(error('InvalidRange', 416));
		await expect(provider.getFile(key, { start: 999 })).rejects.toBeInstanceOf(RangeError);
		for (const action of [
			() => provider.upload(upload),
			() => provider.getMetadata(key),
			() => provider.getFile(key),
			() => provider.delete(key)
		]) {
			send.mockRejectedValueOnce(error('AccessDenied', 403));
			await expect(action()).rejects.toThrow('R2 Storage operation failed');
		}
	});
	it('closes streams on invalid range responses instead of returning incorrect audio', async () => {
		const { provider } = setup();
		for (const response of [
			{ ContentLength: 4 },
			{ ContentLength: 4, ContentRange: 'bytes 1-4/14' },
			{ ContentLength: 3, ContentRange: 'bytes 0-3/14' }
		]) {
			const stream = Readable.from(data);
			send.mockResolvedValueOnce({ Body: stream, ...response });
			await expect(provider.getFile(key, { start: 0, end: 3 })).rejects.toThrow('Invalid R2 range response');
			expect(stream.destroyed).toBe(true);
		}
	});
	it('keeps historical local/Supabase locations readable after selecting R2 and authorizes R2 exports by owner', async () => {
		const { provider, config } = setup({ ...fixture, STORAGE_PROVIDER: 'r2' });
		const local = { getMetadata: vi.fn(async () => ({ size: 1, contentType: 'audio/wav' })) };
		const supabase = { getMetadata: vi.fn(async () => ({ size: 2, contentType: 'audio/wav' })) };
		send.mockImplementation((async (command: any) =>
			command instanceof PutObjectCommand ? {} : { ContentLength: 3, ContentType: 'audio/wav' }) as any);
		const service = new StorageService(config, local as any, supabase as any, provider, {
			begin: async () => ({ id: 'fixture-upload' }),
			ready: async () => true
		} as any);
		expect(await service.upload(upload)).toBe('r2://' + key);
		expect((await service.getMetadata('local://' + key)).size).toBe(1);
		expect((await service.getMetadata('supabase://' + key)).size).toBe(2);
		await expect(service.getMetadata('uploads/' + key)).rejects.toMatchObject({ status: 400 });
		config.set('STORAGE_PROVIDER', 'local');
		expect((await service.getMetadata('r2://' + key)).size).toBe(3);
		expect(ownedExportKey('r2://' + key, 54)).toBe(true);
		expect(ownedExportKey('r2://' + key, 55)).toBe(false);
		expect(ownedExportKey('r2://audio-stories/54/exports/../secret.wav', 54)).toBe(false);
		await expect(service.getMetadata('unknown://' + key)).rejects.toMatchObject({ status: 400 });
	});
});

describe('R2 SDK wire requests without live network access', () => {
	it('serializes conditional uploads and byte ranges through the actual S3 SDK', async () => {
		const requests: any[] = [];
		const client = new S3Client({
			region: 'auto',
			endpoint: fixture.R2_ENDPOINT,
			credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
			forcePathStyle: true,
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED',
			requestHandler: {
				handle: async (request: any) => {
					requests.push(request);
					return {
						response: {
							statusCode: request.method === 'GET' ? 206 : 200,
							headers:
								request.method === 'GET'
									? {
											'content-length': '4',
											'content-range': `bytes 0-3/${data.length}`,
											'content-type': 'audio/wav'
										}
									: {},
							body: Readable.from(request.method === 'GET' ? data.subarray(0, 4) : Buffer.alloc(0))
						}
					};
				}
			}
		});
		const { provider } = setup();
		Object.assign(provider, { client, bucket: 'fixture-audio' });
		await provider.upload(upload);
		const file = await provider.getFile(key, { start: 0, end: 3 });
		expect(await bytes(file.stream)).toEqual(data.subarray(0, 4));
		expect(requests[0].headers['if-none-match']).toBe('*');
		expect(requests[0].headers['x-amz-acl']).toBeUndefined();
		expect(requests[0].path).toBe('/fixture-audio/' + key);
		expect(requests[1].headers.range).toBe('bytes=0-3');
		expect(requests.every(request => request.hostname === 'fixture.r2.cloudflarestorage.com')).toBe(true);
	});
});
