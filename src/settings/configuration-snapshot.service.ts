import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppSettingsService } from './app-settings.service.js';
import { loginSecurityEnvironment, processingEnvironment } from './runtime-settings.js';
import { configurationGroups, objectValue } from './configuration-store.js';
/** Scrub arbitrary public JSON too: never expose credential-like fields in diagnostics. */
export function redactConfiguration(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactConfiguration);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				/secret|password|token|api.?key|authorization|database.?url|encrypted/i.test(key)
					? '[REDACTED]'
					: redactConfiguration(child)
			])
		);
	return value;
}
@Injectable()
export class ConfigurationSnapshotService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService,
		private readonly settings: AppSettingsService
	) {}
	async snapshot(debug = false) {
		const { rows, creditPacks } = await this.prisma.$transaction(
			async tx => ({
				rows: await tx.configuration.findMany({ orderBy: { key: 'asc' } }),
				creditPacks: await tx.creditPack.findMany({
					orderBy: { id: 'asc' },
					select: { id: true, name: true, credits: true, amountPaise: true, active: true }
				})
			}),
			{ isolationLevel: 'RepeatableRead' }
		);
		const allConfig = Object.fromEntries(rows.map(row => [row.key, row.value]));
		const providerStatus: Record<string, unknown> = {};
		for (const provider of ['gemini', 'openai']) {
			providerStatus[provider] = {
				source: 'environment',
				configured: !!this.config
					.get<string>(provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY')
					?.trim()
			};
		}
		providerStatus.resend = {
			source: 'environment',
			configured: !!this.config.get<string>('RESEND_API_KEY')?.trim()
		};
		const result: Record<string, unknown> = {
			schemaVersion: 1,
			exportedAt: new Date().toISOString(),
			allConfig,
			creditPacks: creditPacks.map(pack => ({ ...pack, currency: 'INR' })),
			providerStatus,
			paymentStatus: {
				provider: 'razorpay',
				enabled: this.config.get<string>('RAZORPAY_ENABLED') === 'true',
				configured: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].every(
					key => !!this.config.get<string>(key)?.trim()
				)
			}
		};
		if (debug) {
			const effectiveConfig: Record<string, unknown> = {};
			for (const name of ['features', 'processing', 'security', 'storage', 'models', 'pricing'] as const) {
				const section = await this.settings.section(name);
				const [group, path] = configurationGroups[name] as readonly string[];
				const root = objectValue(allConfig[group!]);
				const saved = path ? objectValue(root[path]) : root;
				const fields = Object.fromEntries(
					Object.entries(section.values).map(([key, value]) => {
						const env = (
							{
								outlineModel: 'OPENAI_MODEL',
								cleanupEnabled: 'STORAGE_CLEANUP_ENABLED',
								...processingEnvironment,
								...loginSecurityEnvironment
							} as Record<string, string>
						)[key];
						const raw = env ? this.config.get<string>(env) : undefined;
						const fromEnvironment =
							key === 'cleanupEnabled'
								? raw !== undefined
								: key === 'outlineModel'
									? !!raw?.trim()
									: raw !== undefined && Number.isSafeInteger(Number(raw)) && Number(raw) > 0;
						return [
							key,
							{
								value,
								source: (
									key === 'geminiEnabled' || key === 'openaiEnabled'
										? Object.hasOwn(
												objectValue(
													allConfig[
														key === 'geminiEnabled' ? 'gemini_settings' : 'openai_settings'
													]
												),
												'enabled'
											)
										: Object.hasOwn(saved, key)
								)
									? 'database'
									: fromEnvironment
										? 'environment'
										: 'default'
							}
						];
					})
				);
				if (path) effectiveConfig[group!] = { ...objectValue(effectiveConfig[group!]), [path]: fields };
				else effectiveConfig[group!] = fields;
			}
			const model = await this.settings.analysisModel();
			effectiveConfig.gemini_settings = { analysisModel: { value: model.model, source: model.source } };
			effectiveConfig.resend_settings = {
				fromEmail: {
					value: this.config.get<string>('RESEND_FROM_EMAIL') || 'AutoCanvas <onboarding@resend.dev>',
					source: this.config.get<string>('RESEND_FROM_EMAIL') ? 'environment' : 'default'
				}
			};
			if (allConfig.analysis_settings) effectiveConfig.analysis_settings = allConfig.analysis_settings;
			result.effectiveConfig = effectiveConfig;
			result.clientDefaults =
				'Public app defaults are owned by each client; allConfig contains saved overrides only.';
		}
		return redactConfiguration(result);
	}
}
