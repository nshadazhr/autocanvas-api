import { safeAiError } from '../../ai/usage/safe-ai-error.js';
import { AiUsageService } from '../../ai/usage/ai-usage.service.js';
import { Injectable, Logger } from '@nestjs/common';
import { GeminiKeyManagerService } from './gemini-key-manager.service.js';
import wavefile from 'wavefile';
import { GeminiKeysUnavailableError } from '../errors/gemini-keys-unavailable.error.js';

const { WaveFile } = wavefile;
@Injectable()
export class GeminiTtsService {
	constructor(
		private readonly keyManager: GeminiKeyManagerService,
		private readonly usage: AiUsageService
	) {}
	private readonly logger = new Logger(GeminiTtsService.name);

	async generateSpeech(text: string, voiceName: string, model: string, context: { userId: number }): Promise<Buffer> {
		if (!text.trim()) {
			throw new Error('Speech text cannot be empty');
		}

		const response = await this.generateWithAvailableKey(text, voiceName, model, context.userId);

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

	private async generateWithAvailableKey(text: string, voiceName: string, model: string, userId: number) {
		const maxAttempts = this.keyManager.getKeyCount();

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			let selectedKey: ReturnType<GeminiKeyManagerService['getAvailableClient']>;

			try {
				selectedKey = this.keyManager.getAvailableClient();
			} catch (error: unknown) {
				// Unexpected errors should not be silently treated
				// as quota exhaustion.
				if (
					!(error instanceof Error) ||
					error.message !== 'All Gemini API keys unavailable, cooling down or quota limited'
				) {
					throw error;
				}

				const nextRetryAt = this.keyManager.getNextAvailableAt();

				if (nextRetryAt === null) {
					throw new Error('All Gemini API keys are disabled. Check API key configuration.');
				}

				throw new GeminiKeysUnavailableError('All Gemini API keys are temporarily unavailable', nextRetryAt);
			}

			const { client, index } = selectedKey;

			try {
				return await this.usage.execute(userId, 'tts', text.length, () =>
					client.models.generateContent({
						model,
						contents: [
							{
								role: 'user',
								parts: [{ text }]
							}
						],
						config: {
							responseModalities: ['AUDIO'],
							speechConfig: {
								voiceConfig: {
									prebuiltVoiceConfig: { voiceName }
								}
							}
						}
					})
				);
			} catch (error: unknown) {
				const status = this.getErrorStatus(error);

				if (status === 429) {
					const message = this.getErrorMessage(error);
					this.logger.warn(
						`Gemini key #${index + 1} returned 429; ` +
							`dailyQuotaDetected=${this.isDailyQuotaError(message)}; ` +
							`retryDelayMs=${this.getRetryDelay(error)}; ` +
							`message=${safeAiError(error)}`
					);

					if (this.isDailyQuotaError(message)) {
						this.keyManager.markDailyLimited(index);
					} else {
						this.keyManager.markRateLimited(index, this.getRetryDelay(error));
					}

					// Works for both single-key and multi-key modes.
					// Single-key mode will exit with a retryable error.
					if (this.keyManager.isMultiKeyEnabled()) {
						continue;
					}

					const nextRetryAt = this.keyManager.getNextAvailableAt();

					if (nextRetryAt === null) {
						throw new Error('No recoverable Gemini API key available');
					}

					throw new GeminiKeysUnavailableError('Gemini API quota temporarily unavailable', nextRetryAt);
				}

				if (status === 401) {
					this.keyManager.disableKey(index);

					if (this.keyManager.isMultiKeyEnabled()) {
						continue;
					}

					throw error;
				}

				// Do not rotate for 400 safety/content errors
				// or other unclassified failures.
				throw error;
			}
		}

		const nextRetryAt = this.keyManager.getNextAvailableAt();

		if (nextRetryAt === null) {
			throw new Error('All Gemini API keys are disabled. Check API key configuration.');
		}

		throw new GeminiKeysUnavailableError('All Gemini API keys are cooling down or quota limited', nextRetryAt);
	}

	private getErrorStatus(error: unknown): number | undefined {
		if (typeof error !== 'object' || error === null) {
			return undefined;
		}

		const candidate = error as {
			status?: unknown;
			code?: unknown;
		};

		const status = candidate.status ?? candidate.code;

		if (typeof status === 'number') {
			return status;
		}

		if (typeof status === 'string' && /^\d{3}$/.test(status)) {
			return Number(status);
		}

		return undefined;
	}

	private getErrorMessage(error: unknown): string {
		if (!(error instanceof Error)) {
			return String(error ?? '');
		}

		return error.message;
	}

	private isDailyQuotaError(message: string): boolean {
		return /(?:per day|per_day|requests per day|daily quota|RPD)/i.test(message);
	}

	private getRetryDelay(error: unknown): number {
		const defaultCooldown = 60_000;

		const message = this.getErrorMessage(error);

		// Supports messages containing:
		// "Please retry in 35.5s"
		// "retryDelay: 20s"
		const match = message.match(/(?:retry in|retryDelay["'\s:]*)(\d+(?:\.\d+)?)\s*s\b/i);

		if (match) {
			const seconds = Number(match[1]);

			if (Number.isFinite(seconds) && seconds > 0) {
				return Math.ceil(seconds * 1000);
			}
		}

		return defaultCooldown;
	}
}
