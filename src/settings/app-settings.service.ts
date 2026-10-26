import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { runtimeDefaults, type RuntimeSection, type RuntimeValues } from './runtime-settings.js';

import { configurationGroups, readConfiguration, writeConfiguration, objectValue } from './configuration-store.js';
type Values = Record<string, unknown>;

@Injectable()
export class AppSettingsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService
	) {}

	async analysisModel() {
		const saved = await readConfiguration(this.prisma, 'gemini_settings');
		const fromEnv = this.config.get<string>('GEMINI_MODEL')?.trim();
		return {
			model: typeof saved.analysisModel === 'string' ? saved.analysisModel : fromEnv || 'gemini-3.5-flash',
			source:
				typeof saved.analysisModel === 'string'
					? ('database' as const)
					: fromEnv
						? ('environment' as const)
						: ('default' as const)
		};
	}
	async setAnalysisModel(model: string | null) {
		await this.prisma.$transaction(tx => writeConfiguration(tx, 'gemini_settings', { analysisModel: model }));
		return this.analysisModel();
	}
	private location(name: string, locale: string) {
		if (!Object.hasOwn(configurationGroups, name)) throw new BadRequestException('Unknown settings section');
		if (!['en', 'hi'].includes(locale)) throw new BadRequestException('Unsupported language');
		const [key, path] = configurationGroups[name as keyof typeof configurationGroups] as readonly string[];
		return { key: key!, path: name === 'web-strings' ? locale : path };
	}
	async section(name: string, locale = 'en') {
		const { key, path } = this.location(name, locale);
		const root = await readConfiguration(this.prisma, key);
		const stored = path ? objectValue(root[path]) : root;
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
		if (name === 'features') {
			for (const provider of ['gemini', 'openai']) {
				const providerSettings = await readConfiguration(this.prisma, provider + '_settings');
				if (typeof providerSettings.enabled === 'boolean')
					stored[provider + 'Enabled'] = providerSettings.enabled;
			}
		}
		const allowed = Object.fromEntries(Object.entries(stored).filter(([key]) => Object.hasOwn(defaults, key)));
		return { values: { ...defaults, ...allowed }, defaults };
	}
	private async save(name: string, locale: string, values: Values, replace: boolean) {
		if (Buffer.byteLength(JSON.stringify(values)) > 65536)
			throw new BadRequestException('JSON must be at most 64 KB');
		const { key, path } = this.location(name, locale);
		await this.prisma.$transaction(async tx => {
			const patch = { ...values };
			if (name === 'features') {
				for (const provider of ['gemini', 'openai']) {
					const field = provider + 'Enabled';
					if (Object.hasOwn(patch, field)) {
						await writeConfiguration(tx, provider + '_settings', { enabled: patch[field] });
						delete patch[field];
					}
				}
			}
			await writeConfiguration(tx, key, patch, path, replace);
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
		this.location(name, locale);
		if (name !== 'web-strings' && name !== 'web-settings')
			throw new BadRequestException('Only web configuration supports JSON replacement');
		this.validateWebDocument(name, values, false);
		await this.save(name, locale, values, true);
		return this.section(name, locale);
	}

	async updateSection(name: string, values: Values, locale = 'en') {
		this.location(name, locale);
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
		await this.save(name, locale, values, false);
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
