import { beforeEach, describe, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ keys: [] as string[], generate: vi.fn() }));
vi.mock('@google/genai', () => ({
	GoogleGenAI: class {
		models = { generateContent: sdk.generate };
		constructor(options: { apiKey: string }) {
			sdk.keys.push(options.apiKey);
		}
	}
}));
import { GeminiTtsService } from './gemini-tts.service.js';
import { ProviderRateLimitError } from '../errors/provider-rate-limit.error.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { AiCapacityError } from '../../ai/usage/ai-capacity.error.js';

describe('single-key Gemini audio', () => {
	const credentials = { primary: vi.fn() };
	const settings = { assertEnabled: vi.fn() };
	const usage = { execute: vi.fn((_user, _kind, _size, action) => action()) };
	const service = new GeminiTtsService(credentials as any, settings as any, usage as any);
	const generate = () => service.generateSpeech('Fixture speech', 'Kore', 'fixture-tts-model', { userId: 1 });
	beforeEach(() => {
		vi.clearAllMocks();
		sdk.keys.length = 0;
		credentials.primary.mockResolvedValue('fixture-single-key');
		settings.assertEnabled.mockResolvedValue(undefined);
		usage.execute.mockImplementation((_user, _kind, _size, action) => action());
		sdk.generate.mockResolvedValue({
			candidates: [
				{
					content: {
						parts: [
							{
								inlineData: {
									data: Buffer.from([0, 0, 1, 0]).toString('base64'),
									mimeType: 'audio/L16;rate=24000'
								}
							}
						]
					}
				}
			]
		});
	});
	it('makes one provider request and returns WAV audio', async () => {
		const audio = await generate();
		expect(audio.subarray(0, 4).toString()).toBe('RIFF');
		expect(sdk.keys).toEqual(['fixture-single-key']);
		expect(sdk.generate).toHaveBeenCalledTimes(1);
	});
	it('blocks new admission during maintenance while accepted work can finish unless its provider is disabled', async () => {
		const runtime = new AppSettingsService({} as any, {} as any);
		const flags = { maintenanceMode: true, audioEnabled: true, geminiEnabled: true };
		vi.spyOn(runtime, 'section').mockImplementation(async () => ({ values: { ...flags }, defaults: {} }));
		const acceptedWork = new GeminiTtsService(credentials as any, runtime, usage as any);
		await expect(acceptedWork.assertEnabled()).rejects.toThrow('temporarily disabled');
		const audio = await acceptedWork.generateSpeech('Accepted before maintenance', 'Kore', 'fixture-model', {
			userId: 1
		});
		expect(audio.subarray(0, 4).toString()).toBe('RIFF');
		expect(sdk.generate).toHaveBeenCalledTimes(1);
		flags.geminiEnabled = false;
		await expect(
			acceptedWork.generateSpeech('Accepted work', 'Kore', 'fixture-model', { userId: 1 })
		).rejects.toThrow('temporarily disabled');
		expect(sdk.generate).toHaveBeenCalledTimes(1);
	});
	it('treats an invalid-key HTTP 400 as terminal configuration failure without exposing the key', async () => {
		sdk.generate.mockRejectedValue(
			Object.assign(new Error('API key not valid. API_KEY_INVALID fixture-single-key'), { status: 400 })
		);
		await expect(generate()).rejects.toMatchObject({
			nonRetryable: true,
			status: 400,
			message: 'The audio provider API key is invalid or unavailable. Contact an administrator.'
		});
		expect(sdk.generate).toHaveBeenCalledTimes(1);
	});

	it('does not switch keys on authentication errors and redacts the current key', async () => {
		sdk.generate.mockRejectedValue(Object.assign(new Error('401 rejected fixture-single-key'), { status: 401 }));
		await expect(generate()).rejects.toThrow('401 rejected [redacted]');
		expect(credentials.primary).toHaveBeenCalledTimes(1);
		expect(sdk.generate).toHaveBeenCalledTimes(1);
	});
	it('returns a retry schedule for 429 without trying another key', async () => {
		sdk.generate.mockRejectedValue(Object.assign(new Error('Please retry in 20s'), { status: 429 }));
		const now = Date.now();
		const error = await generate().catch(error => error);
		expect(error).toBeInstanceOf(ProviderRateLimitError);
		expect(error.nextRetryAt.getTime()).toBeGreaterThanOrEqual(now + 20000);
		expect(sdk.generate).toHaveBeenCalledTimes(1);
		await expect(generate()).rejects.toBeInstanceOf(ProviderRateLimitError);
		expect(sdk.keys).toEqual(['fixture-single-key', 'fixture-single-key']);
	});
	it('uses a manually replaced key only on the next request', async () => {
		await generate();
		credentials.primary.mockResolvedValue('fixture-manual-replacement');
		await generate();
		expect(sdk.keys).toEqual(['fixture-single-key', 'fixture-manual-replacement']);
	});
	it('preserves shared-capacity errors and prevents provider calls when disabled', async () => {
		const error = new AiCapacityError(new Date(Date.now() + 60000));
		usage.execute.mockRejectedValueOnce(error);
		await expect(generate()).rejects.toBe(error);
		settings.assertEnabled.mockRejectedValueOnce(new Error('Provider disabled'));
		await expect(generate()).rejects.toThrow('Provider disabled');
		expect(sdk.generate).not.toHaveBeenCalled();
	});
	it('does not retry content errors or empty audio responses inside the provider client', async () => {
		sdk.generate.mockRejectedValueOnce(Object.assign(new Error('400 safety'), { status: 400 }));
		await expect(generate()).rejects.toThrow('400 safety');
		sdk.generate.mockResolvedValueOnce({ candidates: [] });
		await expect(generate()).rejects.toThrow('Gemini returned no audio');
		expect(sdk.generate).toHaveBeenCalledTimes(2);
	});
});
