import { describe, expect, it } from 'vitest';
import { ProviderCredentialsService } from './provider-credentials.service.js';

describe('environment-only provider credentials', () => {
	it('resolves each provider from its own environment setting without database access', async () => {
		const values: Record<string, string> = { GEMINI_API_KEY: ' fixture-gemini ', OPENAI_API_KEY: 'fixture-openai' };
		const service = new ProviderCredentialsService({ get: (name: string) => values[name] } as any);
		expect(await service.primary('gemini')).toBe('fixture-gemini');
		expect(await service.primary('openai')).toBe('fixture-openai');
		values.GEMINI_API_KEY = 'fixture-replacement';
		expect(await service.primary('gemini')).toBe('fixture-replacement');
	});
	it.each(['gemini', 'openai'])(
		'fails without a configured %s key instead of using another provider',
		async provider => {
			const service = new ProviderCredentialsService({
				get: (name: string) =>
					name === (provider === 'gemini' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY') ? 'fixture-other' : ' '
			} as any);
			await expect(service.primary(provider)).rejects.toMatchObject({ status: 503, nonRetryable: true });
		}
	);
	it('rejects unsupported provider names', async () => {
		const service = new ProviderCredentialsService({ get: () => 'fixture' } as any);
		await expect(service.primary('unsupported')).rejects.toMatchObject({ status: 400 });
	});
});
