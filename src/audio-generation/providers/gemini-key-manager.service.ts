import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';

type KeyEntry = {
	client: GoogleGenAI;
	cooldownUntil: number;
	disabled: boolean;
	requestTimes: number[];
	dailyRequests: number;
	dailyDate: string;
};

@Injectable()
export class GeminiKeyManagerService {
	private readonly logger = new Logger(GeminiKeyManagerService.name);
	private readonly keys: KeyEntry[];
	private readonly multiKeyEnabled: boolean;

	private readonly rpmLimit: number;
	private readonly rpdLimit: number;
	private nextIndex = 0;

	constructor(private readonly configService: ConfigService) {
		this.multiKeyEnabled = this.configService.get<string>('GEMINI_MULTI_KEY_ENABLED') === 'true';

		this.rpmLimit = this.readPositiveLimit('GEMINI_RPM_LIMIT', 3);
		this.rpdLimit = this.readPositiveLimit('GEMINI_RPD_LIMIT', 10);

		const primaryKey = this.configService.getOrThrow<string>('GEMINI_API_KEY');

		const configuredKeys = this.multiKeyEnabled
			? [
					primaryKey,
					...(this.configService.get<string>('GEMINI_API_KEYS') ?? '')
						.split(',')
						.map(key => key.trim())
						.filter(Boolean)
				]
			: [primaryKey];

		const today = this.getPacificDate();

		this.keys = [...new Set(configuredKeys)].map(apiKey => ({
			client: new GoogleGenAI({ apiKey, httpOptions: { timeout: 90_000 } }),
			cooldownUntil: 0,
			disabled: false,
			requestTimes: [],
			dailyRequests: 0,
			dailyDate: today
		}));

		this.logger.log(
			`Gemini mode: ${this.multiKeyEnabled ? 'MULTIPLE' : 'SINGLE'}; ` +
				`keys: ${this.keys.length}; RPM: ${this.rpmLimit}; RPD: ${this.rpdLimit}`
		);
	}

	private readPositiveLimit(name: string, fallback: number): number {
		const value = Number(this.configService.get<string>(name));

		return Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}

	private getPacificDate(date: Date = new Date()): string {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: 'America/Los_Angeles',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});

		const parts = formatter.formatToParts(date);

		const getPart = (type: string): string => {
			return parts.find(part => part.type === type)?.value ?? '';
		};

		return [getPart('year'), getPart('month'), getPart('day')].join('-');
	}

	private refreshUsage(entry: KeyEntry, now: number): void {
		entry.requestTimes = entry.requestTimes.filter(time => now - time < 60_000);

		const today = this.getPacificDate();

		if (entry.dailyDate !== today) {
			entry.dailyDate = today;
			entry.dailyRequests = 0;
		}
	}

	getAvailableClient(): { client: GoogleGenAI; index: number } {
		const now = Date.now();

		for (let offset = 0; offset < this.keys.length; offset++) {
			const index = (this.nextIndex + offset) % this.keys.length;
			const entry = this.keys[index];

			this.refreshUsage(entry, now);

			if (entry.disabled || entry.cooldownUntil > now) {
				continue;
			}

			if (entry.requestTimes.length >= this.rpmLimit || entry.dailyRequests >= this.rpdLimit) {
				continue;
			}

			// Reserve one request before the API call.
			entry.requestTimes.push(now);
			entry.dailyRequests++;

			// Sticky selection: retain this key.
			this.nextIndex = index;

			this.logger.debug(
				`Selected Gemini key #${index + 1}; ` +
					`RPM: ${entry.requestTimes.length}/${this.rpmLimit}; ` +
					`RPD: ${entry.dailyRequests}/${this.rpdLimit}`
			);

			return { client: entry.client, index };
		}

		throw new Error('All Gemini API keys unavailable, cooling down or quota limited');
	}

	markRateLimited(index: number, cooldownMs = 60_000): void {
		const entry = this.keys[index];
		if (!entry) return;

		entry.cooldownUntil = Math.max(entry.cooldownUntil, Date.now() + cooldownMs);

		this.logger.warn(`Gemini key #${index + 1} entered cooldown`);
	}

	markDailyLimited(index: number): void {
		const entry = this.keys[index];
		if (!entry) return;

		entry.cooldownUntil = Math.max(entry.cooldownUntil, this.getNextPacificMidnight());

		this.logger.warn(`Gemini key #${index + 1} daily quota exhausted`);
	}

	disableKey(index: number): void {
		const entry = this.keys[index];
		if (!entry) return;

		entry.disabled = true;
		this.logger.warn(`Gemini key #${index + 1} disabled`);
	}

	getKeyCount(): number {
		return this.keys.length;
	}

	isMultiKeyEnabled(): boolean {
		return this.multiKeyEnabled;
	}

	private getNextPacificMidnight(): number {
		const now = Date.now();
		const currentDate = this.getPacificDate(new Date(now));

		const [year, month, day] = currentDate.split('-').map(Number);

		const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);

		let low = now;
		let high = now + 49 * 60 * 60 * 1000;

		while (high - low > 1000) {
			const mid = Math.floor((low + high) / 2);
			const pacificDate = this.getPacificDate(new Date(mid));

			if (pacificDate >= nextDate) {
				high = mid;
			} else {
				low = mid;
			}
		}

		return high;
	}

	getNextAvailableAt(): Date | null {
		const now = Date.now();
		let earliest = Number.POSITIVE_INFINITY;

		for (const entry of this.keys) {
			if (entry.disabled) continue;

			this.refreshUsage(entry, now);

			let availableAt = Math.max(now, entry.cooldownUntil);

			if (entry.requestTimes.length >= this.rpmLimit) {
				const oldestRequest = entry.requestTimes[0];
				availableAt = Math.max(availableAt, oldestRequest + 60_000);
			}

			if (entry.dailyRequests >= this.rpdLimit) {
				availableAt = Math.max(availableAt, this.getNextPacificMidnight());
			}

			earliest = Math.min(earliest, availableAt);
		}

		if (!Number.isFinite(earliest)) {
			return null;
		}

		return new Date(earliest);
	}
}
