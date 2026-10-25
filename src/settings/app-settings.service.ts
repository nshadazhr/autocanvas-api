import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { runtimeDefaults, type RuntimeSection, type RuntimeValues } from './runtime-settings.js';

const ANALYSIS_MODEL_KEY = 'analysis.gemini.model';
type Values = Record<string, unknown>;

@Injectable()
export class AppSettingsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService
	) {}

	async analysisModel() {
		const saved = await this.prisma.appSetting.findUnique({ where: { key: ANALYSIS_MODEL_KEY } });
		const fromEnv = this.config.get<string>('GEMINI_MODEL')?.trim();
		return {
			model: saved?.value ?? (fromEnv || 'gemini-3.5-flash'),
			source: saved ? ('database' as const) : fromEnv ? ('environment' as const) : ('default' as const)
		};
	}

	async setAnalysisModel(model: string | null) {
		if (model === null) await this.prisma.appSetting.deleteMany({ where: { key: ANALYSIS_MODEL_KEY } });
		else
			await this.prisma.appSetting.upsert({
				where: { key: ANALYSIS_MODEL_KEY },
				create: { key: ANALYSIS_MODEL_KEY, value: model },
				update: { value: model }
			});
		return this.analysisModel();
	}

	private sectionKey(name: string, locale: string) {
		if (name !== 'web-strings' && !Object.hasOwn(runtimeDefaults, name))
			throw new BadRequestException('Unknown settings section');
		if (!['en', 'hi'].includes(locale)) throw new BadRequestException('Unsupported language');
		return name === 'web-strings' ? 'web.strings.' + locale : 'runtime.' + name;
	}

	async section(name: string, locale = 'en') {
		const key = this.sectionKey(name, locale);
		const row = await this.prisma.appSetting.findUnique({ where: { key } });
		const stored: Values = row ? JSON.parse(row.value) : {};
		// Public web JSON contains only saved overrides. The web app owns its local defaults.
		if (name === 'web-strings' || name === 'web-settings') return { values: stored, defaults: {} };
		const defaults: RuntimeValues = { ...runtimeDefaults[name as RuntimeSection] };
		if (name === 'models') defaults.outlineModel = this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4.1';
		if (name === 'processing') {
			for (const [field, env] of Object.entries({
				maxRecoveryAttempts: 'AUDIO_MAX_RECOVERY_ATTEMPTS',
				recoveryRetryDelayMs: 'AUDIO_RECOVERY_RETRY_DELAY_MS'
			})) {
				const value = Number(this.config.get<string>(env));
				if (Number.isSafeInteger(value) && value > 0) defaults[field] = value;
			}
		}
		const allowed = Object.fromEntries(Object.entries(stored).filter(([key]) => Object.hasOwn(defaults, key)));
		return { values: { ...defaults, ...allowed }, defaults };
	}

	/** One database writer: PUT replaces the document; PATCH merges fields and null removes them. */
	private async save(key: string, values: Values, replace: boolean) {
		await this.prisma.$transaction(async tx => {
			await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73127, 0)`;
			const old = replace ? null : await tx.appSetting.findUnique({ where: { key } });
			const next: Values = old ? JSON.parse(old.value) : {};
			for (const [field, value] of Object.entries(values)) {
				if (!replace && value === null) delete next[field];
				else next[field] = value;
			}
			const value = JSON.stringify(next);
			if (Buffer.byteLength(value) > 65536) throw new BadRequestException('JSON must be at most 64 KB');
			await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
		});
	}

	private validateWebDocument(name: string, values: Values, patch: boolean) {
		if (!values || typeof values !== 'object' || Array.isArray(values))
			throw new BadRequestException('JSON must be an object');
		const visit = (value: unknown, depth = 0): void => {
			if (depth > 20) throw new BadRequestException('JSON nesting is too deep');
			if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
			if (typeof value === 'number' && Number.isFinite(value)) return;
			if (!value || typeof value !== 'object') throw new BadRequestException('Invalid JSON value');
			for (const [key, child] of Object.entries(value)) {
				if (['__proto__', 'constructor', 'prototype'].includes(key))
					throw new BadRequestException('Unsupported JSON key: ' + key);
				visit(child, depth + 1);
			}
		};
		visit(values);
		for (const [key, value] of Object.entries(values)) {
			if (patch && value === null) continue;
			if (name === 'web-strings' && typeof value !== 'string')
				throw new BadRequestException('App Strings must be a JSON object with text values');
			if (name === 'web-settings') {
				const known: RuntimeValues = runtimeDefaults['web-settings'];
				if (Object.hasOwn(known, key) && typeof value !== typeof known[key])
					throw new BadRequestException('Invalid setting type: ' + key);
				if (key === 'defaultLanguage' && !['en', 'hi'].includes(String(value)))
					throw new BadRequestException('Unsupported language');
			}
		}
	}

	async replaceWebDocument(name: string, values: Values, locale = 'en') {
		const key = this.sectionKey(name, locale);
		if (name !== 'web-strings' && name !== 'web-settings')
			throw new BadRequestException('Only web configuration supports JSON replacement');
		this.validateWebDocument(name, values, false);
		await this.save(key, values, true);
		return this.section(name, locale);
	}

	async updateSection(name: string, values: Values, locale = 'en') {
		const key = this.sectionKey(name, locale);
		if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 200)
			throw new BadRequestException('Invalid settings values');
		if (name === 'web-strings' || name === 'web-settings') this.validateWebDocument(name, values, true);
		else {
			const defaults: RuntimeValues = runtimeDefaults[name as RuntimeSection];
			for (const [field, value] of Object.entries(values)) {
				if (!Object.hasOwn(defaults, field)) throw new BadRequestException('Unknown setting: ' + field);
				if (value === null) continue;
				if (typeof value !== typeof defaults[field])
					throw new BadRequestException('Invalid setting type: ' + field);
				if (
					typeof value === 'number' &&
					(!Number.isSafeInteger(value) || value < (name === 'pricing' ? 0 : 1) || value > 1000000)
				)
					throw new BadRequestException('Numeric setting is out of range');
				if (field === 'outlineModel' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(String(value)))
					throw new BadRequestException('Invalid model ID');
				if (field === 'maxRecoveryAttempts' && Number(value) > 10)
					throw new BadRequestException('Recovery attempts must be 1–10');
				if (field === 'recoveryRetryDelayMs' && Number(value) < 1000)
					throw new BadRequestException('Retry delay must be at least 1000 ms');
			}
		}
		await this.save(key, values, false);
		return this.section(name, locale);
	}

	async assertEnabled(
		feature: 'audioEnabled' | 'analysisEnabled' | 'scriptEnabled' | 'geminiEnabled' | 'openaiEnabled'
	) {
		const { values } = await this.section('features');
		if (values.maintenanceMode || !values[feature])
			throw Object.assign(
				new ServiceUnavailableException('This feature is temporarily disabled by an administrator.'),
				{ nonRetryable: true }
			);
	}

	/** Public startup data only. Never read provider credentials or private settings here. */
	async appConfig(locale?: string) {
		const { values: appSettings } = await this.section('web-settings');
		const language = locale || String(appSettings.defaultLanguage ?? 'en');
		const [{ values: appStrings }, { values: flags }] = await Promise.all([
			this.section('web-strings', language),
			this.section('features')
		]);
		return {
			appSettings,
			appStrings,
			locale: language,
			features: {
				maintenanceMode: flags.maintenanceMode,
				audioEnabled: flags.audioEnabled,
				analysisEnabled: flags.analysisEnabled,
				scriptEnabled: flags.scriptEnabled
			}
		};
	}
}
