import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import {
	loginSecurityEnvironment,
	processingEnvironment,
	runtimeDefaults,
	type RuntimeSection,
	type RuntimeValues
} from './runtime-settings.js';

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
		if (Object.keys(await readConfiguration(this.prisma, 'analysis_settings')).length)
			throw new BadRequestException('Use analysis provider/model configuration after it has been saved');
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
		if (name === 'storage') {
			const value = this.config.get<string>('STORAGE_CLEANUP_ENABLED');
			if (value !== undefined) defaults.cleanupEnabled = value !== 'false';
		}
		if (name === 'payments') {
			const value = this.config.get<string>('RAZORPAY_ENABLED');
			if (value !== undefined) defaults.checkoutEnabled = value === 'true';
		}
		if (name === 'models') defaults.outlineModel = this.config.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4.1';
		if (name === 'processing' || name === 'security') {
			for (const [field, env] of Object.entries(
				name === 'security' ? loginSecurityEnvironment : processingEnvironment
			)) {
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
			if (name === 'maintenance') patch.reminderIntervalMinutes = null;
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
			if (name === 'maintenance') {
				const root = await readConfiguration(tx, key);
				this.validateMaintenanceNotice({ ...runtimeDefaults.maintenance, ...objectValue(root[path!]) });
			}
		});
	}

	private validateMaintenanceNotice(values: Values) {
		if (
			typeof values.noticeEnabled !== 'boolean' ||
			typeof values.message !== 'string' ||
			typeof values.startsAt !== 'string' ||
			typeof values.endsAt !== 'string'
		)
			throw new BadRequestException('Invalid maintenance notice');
		const reminders = [values.earlyReminderMinutes, values.soonReminderMinutes, values.finalReminderMinutes];
		if (
			reminders.some(value => !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1440) ||
			!(Number(reminders[0]) > Number(reminders[1]) && Number(reminders[1]) > Number(reminders[2]))
		)
			throw new BadRequestException('Reminder times must be descending whole minutes: early > soon > final');
		if (values.message.length > 500)
			throw new BadRequestException('Maintenance message must be at most 500 characters');
		for (const field of ['startsAt', 'endsAt'] as const) {
			const value = values[field] as string;
			if (!value) continue;
			const time = new Date(value);
			if (!Number.isFinite(time.getTime()) || time.toISOString() !== value)
				throw new BadRequestException('Maintenance times must be canonical UTC ISO timestamps');
		}
		if (values.startsAt && values.endsAt && Date.parse(values.endsAt) <= Date.parse(values.startsAt))
			throw new BadRequestException('Maintenance end must be after its start');
		if (values.noticeEnabled && (!values.message.trim() || !values.startsAt || !values.endsAt))
			throw new BadRequestException('An enabled notice requires a message and planned start/end');
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
		if (name === 'maintenance' && typeof values.message === 'string')
			values = { ...values, message: values.message.trim() };
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
					(!Number.isSafeInteger(value) ||
						value < (name === 'pricing' ? 0 : 1) ||
						value > (name === 'processing' && field.endsWith('CharactersPerDay') ? 1000000000 : 1000000))
				)
					throw new BadRequestException('Numeric setting is out of range');
				if (name === 'maintenance' && field.endsWith('ReminderMinutes') && Number(value) > 1440)
					throw new BadRequestException('Reminder times must be 1–1440 minutes before start');
				if (field === 'outlineModel' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(String(value)))
					throw new BadRequestException('Invalid model ID');
				if (field === 'maxRecoveryAttempts' && Number(value) > 10)
					throw new BadRequestException('Recovery attempts must be 1–10');
				if (field === 'retryScanIntervalMs' && Number(value) < 1000)
					throw new BadRequestException('Retry scan interval must be at least 1000 ms');
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
		// Maintenance closes admission; accepted jobs still check their provider's own switch.
		const admission = feature === 'audioEnabled' || feature === 'analysisEnabled' || feature === 'scriptEnabled';
		if ((admission && values.maintenanceMode) || !values[feature])
			throw Object.assign(
				new ServiceUnavailableException('This feature is temporarily disabled by an administrator.'),
				{ nonRetryable: true }
			);
	}

	private publicMaintenanceNotice(notice: Values) {
		return notice.noticeEnabled === true &&
			typeof notice.message === 'string' &&
			typeof notice.startsAt === 'string' &&
			typeof notice.endsAt === 'string' &&
			notice.message.trim().length > 0 &&
			notice.message.length <= 500 &&
			Number.isFinite(Date.parse(notice.startsAt)) &&
			Date.parse(notice.endsAt) > Date.now() &&
			Date.parse(notice.endsAt) > Date.parse(notice.startsAt)
			? {
					enabled: true,
					message: notice.message,
					startsAt: notice.startsAt,
					endsAt: notice.endsAt,
					reminderMinutes: [
						notice.earlyReminderMinutes,
						notice.soonReminderMinutes,
						notice.finalReminderMinutes
					]
				}
			: null;
	}

	/** Public status only; ordinary frontend settings/strings are loaded once at bootstrap. */
	async maintenanceStatus() {
		const [{ values: flags }, { values: notice }] = await Promise.all([
			this.section('features'),
			this.section('maintenance')
		]);
		return {
			maintenanceMode: flags.maintenanceMode === true,
			maintenanceNotice: this.publicMaintenanceNotice(notice)
		};
	}

	/** Public allowlists only: never return credentials or whole private configuration sections. */
	async appConfig(locale?: string) {
		const { values: appSettings } = await this.section('web-settings');
		const language = locale || String(appSettings.defaultLanguage ?? 'en');
		const [{ values: appStrings }, { values: flags }, { values: notice }] = await Promise.all([
			this.section('web-strings', language),
			this.section('features'),
			this.section('maintenance')
		]);
		return {
			appSettings,
			appStrings,
			locale: language,
			maintenanceNotice: this.publicMaintenanceNotice(notice),
			features: {
				maintenanceMode: flags.maintenanceMode,
				audioEnabled: flags.audioEnabled,
				analysisEnabled: flags.analysisEnabled,
				scriptEnabled: flags.scriptEnabled
			}
		};
	}
}
