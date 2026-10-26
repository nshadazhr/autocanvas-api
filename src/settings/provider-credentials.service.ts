import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readConfiguration, writeConfiguration } from './configuration-store.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class ProviderCredentialsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService
	) {}
	private provider(provider: string) {
		if (!['gemini', 'openai'].includes(provider)) throw new BadRequestException('Unsupported provider');
		return provider;
	}
	private master() {
		const text = this.config.get<string>('AI_KEYS_ENCRYPTION_KEY') || '';
		const key = Buffer.from(text, 'base64');
		if (key.length !== 32 || key.toString('base64') !== text)
			throw Object.assign(
				new ServiceUnavailableException(
					'Provider key management requires AI_KEYS_ENCRYPTION_KEY on the backend.'
				),
				{ nonRetryable: true }
			);
		return key;
	}
	private encrypt(value: string, id: string, provider: string) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.master(), iv);
		cipher.setAAD(Buffer.from(provider + ':' + id));
		const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
		return [iv, cipher.getAuthTag(), data].map(value => value.toString('base64')).join('.');
	}
	private decrypt(encrypted: string, id: string, provider: string) {
		try {
			const [iv, tag, data] = encrypted.split('.').map(value => Buffer.from(value, 'base64'));
			const decipher = createDecipheriv('aes-256-gcm', this.master(), iv);
			decipher.setAAD(Buffer.from(provider + ':' + id));
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
		} catch {
			throw Object.assign(
				new ServiceUnavailableException(
					'Provider credentials could not be decrypted. Check backend encryption configuration.'
				),
				{ nonRetryable: true }
			);
		}
	}
	private envKey(provider: string) {
		return this.config.get<string>(provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY')?.trim() || '';
	}
	private modeKey(provider: string) {
		return provider + '_settings';
	}
	async list(provider: string) {
		this.provider(provider);
		let encryptionReady = true;
		try {
			this.master();
		} catch {
			encryptionReady = false;
		}
		const managed = await readConfiguration(this.prisma, this.modeKey(provider));
		const keys = await this.prisma.providerCredential.findMany({
			where: { provider },
			take: 1,
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
			select: { id: true, name: true, suffix: true, enabled: true, createdAt: true }
		});
		return {
			managed: managed.credentialMode === 'dashboard',
			encryptionReady,
			environmentKeyCount: this.envKey(provider) ? 1 : 0,
			keys: keys
				.filter(row => row.suffix !== '')
				.map(({ suffix, ...key }) => ({ ...key, maskedKey: '••••' + suffix }))
		};
	}
	async available(provider: string): Promise<Array<{ id: string; key: string }>> {
		this.provider(provider);
		const mode = await readConfiguration(this.prisma, this.modeKey(provider));
		if (mode.credentialMode !== 'dashboard') {
			const key = this.envKey(provider);
			return key ? [{ id: 'environment', key }] : [];
		}
		// A disabled/invalid primary never falls through to an old saved key.
		const row = await this.prisma.providerCredential.findFirst({
			where: { provider },
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
		});
		return row?.enabled ? [{ id: row.id, key: this.decrypt(row.encrypted, row.id, provider) }] : [];
	}
	async primary(provider: string) {
		const keys = await this.available(provider);
		if (!keys.length)
			throw Object.assign(new ServiceUnavailableException('No enabled ' + provider + ' API key is available.'), {
				nonRetryable: true
			});
		return keys[0].key;
	}
	async add(provider: string, name: string, key: string) {
		this.provider(provider);
		if (
			typeof name !== 'string' ||
			!name.trim() ||
			name.trim().length > 80 ||
			typeof key !== 'string' ||
			key.length < 8 ||
			key.length > 4096 ||
			/\s/.test(key)
		)
			throw new BadRequestException('Enter a key name (1–80 characters) and a valid API key.');
		await this.prisma.$transaction(async tx => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73128, 0)`;
			// Explicit saves update only the primary record. Legacy extras are preserved and never selected.
			const current = await tx.providerCredential.findFirst({
				where: { provider },
				orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
			});
			const id = current?.id ?? randomUUID();
			const data = {
				provider,
				name: name.trim(),
				encrypted: this.encrypt(key, id, provider),
				fingerprint: createHash('sha256')
					.update(id + ':' + key)
					.digest('hex'),
				suffix: key.slice(-4),
				enabled: true
			};
			await tx.providerCredential.upsert({ where: { id }, create: { id, ...data }, update: data });
			await writeConfiguration(tx, this.modeKey(provider), { credentialMode: 'dashboard' });
		});
		return this.list(provider);
	}
	async importEnvironment(provider: string) {
		this.provider(provider);
		const key = this.envKey(provider);
		if (!key) throw new BadRequestException('No environment key is configured for this provider.');
		return this.add(provider, 'Imported ' + provider + ' key', key);
	}
	async change(provider: string, id: string, enabled: boolean) {
		this.provider(provider);
		const changed = await this.prisma.providerCredential.updateMany({
			where: { id, provider },
			data: { enabled }
		});
		if (!changed.count) throw new NotFoundException('Provider key not found');
		return this.list(provider);
	}
	async remove(provider: string, id: string) {
		this.provider(provider);
		// Leave a disabled primary record so old extra keys can never become an automatic fallback.
		const removed = await this.prisma.providerCredential.updateMany({
			where: { id, provider },
			data: { encrypted: '', suffix: '', enabled: false }
		});
		if (!removed.count) throw new NotFoundException('Provider key not found');
		return this.list(provider);
	}
	async useEnvironment(provider: string) {
		this.provider(provider);
		await this.prisma.$transaction(tx => writeConfiguration(tx, this.modeKey(provider), { credentialMode: null }));
		return this.list(provider);
	}
}
