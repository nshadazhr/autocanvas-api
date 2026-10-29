import { safeAiError, isInvalidProviderKey } from '../../ai/usage/safe-ai-error.js';
import { AiUsageService } from '../../ai/usage/ai-usage.service.js';
import { AiCapacityError } from '../../ai/usage/ai-capacity.error.js';
import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { ProviderCredentialsService } from '../../settings/provider-credentials.service.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { ProviderRateLimitError } from '../errors/provider-rate-limit.error.js';
import wavefile from 'wavefile';

const { WaveFile } = wavefile;
@Injectable()
export class GeminiTtsService {
	constructor(
		private readonly credentials: ProviderCredentialsService,
		private readonly settings: AppSettingsService,
		private readonly usage: AiUsageService
	) {}

	assertEnabled() {
		return this.settings.assertEnabled('audioEnabled');
	}

	async generateSpeech(text: string, voiceName: string, model: string, context: { userId: number }): Promise<Buffer> {
		if (!text.trim()) {
			throw new Error('Speech text cannot be empty');
		}

		const response = await this.generateWithKey(text, voiceName, model, context.userId);

		const audioPart = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data);

		const base64 = audioPart?.inlineData?.data;

		if (!base64) {
			throw new Error('Gemini returned no audio');
		}

		const mimeType = audioPart?.inlineData?.mimeType;

		// FIX: Accept supported Gemini PCM MIME formats
		const normalizedMimeType = mimeType?.toLowerCase().replace(/\s+/g, '');

		const mimeParts = normalizedMimeType?.split(';') ?? [];
		const audioType = mimeParts[0];
		const parameters = mimeParts.slice(1);

		const isValidPcm =
			audioType === 'audio/l16' &&
			parameters.includes('rate=24000') &&
			parameters.every(param => param === 'rate=24000' || param === 'channels=1' || param === 'codec=pcm');

		if (!isValidPcm) {
			throw new Error(`Unexpected audio format: ${mimeType}`);
		}

		const pcmBuffer = Buffer.from(base64, 'base64');

		if (pcmBuffer.length === 0 || pcmBuffer.length % 2 !== 0) {
			throw new Error('Invalid PCM audio data');
		}

		const samples = new Int16Array(pcmBuffer.length / 2);

		for (let i = 0; i < samples.length; i++) {
			samples[i] = pcmBuffer.readInt16LE(i * 2);
		}

		const wav = new WaveFile();
		wav.fromScratch(1, 24000, '16', Array.from(samples));

		return Buffer.from(wav.toBuffer());
	}

	/** One provider request with the current key. No pool, counters or key failover. */
	private async generateWithKey(text: string, voiceName: string, model: string, userId: number) {
		await this.settings.assertEnabled('geminiEnabled');
		const apiKey = await this.credentials.primary('gemini');
		const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 90000 } });
		try {
			return await this.usage.execute(userId, 'tts', text.length, () =>
				client.models.generateContent({
					model,
					contents: [{ role: 'user', parts: [{ text }] }],
					config: {
						responseModalities: ['AUDIO'],
						speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
					}
				})
			);
		} catch (error) {
			if (error instanceof AiCapacityError) throw error;
			if (isInvalidProviderKey(error))
				throw Object.assign(
					new Error('The audio provider API key is invalid or unavailable. Contact an administrator.'),
					{ status: 400, nonRetryable: true }
				);
			const details = error as { status?: unknown; code?: unknown } | null;
			const status = Number(details?.status ?? details?.code);
			if (status === 429) {
				const message = error instanceof Error ? error.message : '';
				const hint = message.match(/(?:retry in|retryDelay["'\s:]*)(\d+(?:\.\d+)?)\s*s\b/i);
				const delay = hint ? Number(hint[1]) * 1000 : 60000;
				throw new ProviderRateLimitError(
					'Gemini rate limit reached. The job will retry with the same configured key.',
					new Date(Date.now() + delay)
				);
			}
			throw Object.assign(new Error(safeAiError(error).replaceAll(apiKey, '[redacted]')), {
				status: Number.isFinite(status) ? status : undefined,
				code: details?.code
			});
		}
	}
}
