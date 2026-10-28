import { Injectable, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppSettingsService } from './app-settings.service.js';
import { readConfiguration, writeConfiguration } from './configuration-store.js';
import { analysisProviders, type AnalysisSettings } from '../ai/analysis/analysis.types.js';
const modelId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);
const providerSchema = z
	.object({
		primaryModel: modelId.nullable(),
		models: z.array(z.object({ id: modelId, enabled: z.boolean() }).strict()).max(20)
	})
	.strict()
	.superRefine((p, ctx) => {
		if (new Set(p.models.map(m => m.id)).size !== p.models.length)
			ctx.addIssue({ code: 'custom', message: 'Model IDs must be unique within each provider' });
		if (p.primaryModel !== null && !p.models.some(m => m.id === p.primaryModel && m.enabled))
			ctx.addIssue({
				code: 'custom',
				message: 'Choose an enabled primary before removing or disabling the current primary'
			});
		if (p.models.some(m => m.enabled) && p.primaryModel === null)
			ctx.addIssue({ code: 'custom', message: 'Enabled models require a primary model' });
	});
const settingsSchema = z
	.object({
		primaryProvider: z.enum(analysisProviders),
		providerFallback: z.boolean(),
		retryLimit: z.number().int().min(0).max(10),
		retryDelaySeconds: z.number().int().min(1).max(120),
		providers: z.object({ gemini: providerSchema, openai: providerSchema }).strict()
	})
	.strict()
	.superRefine((v, ctx) => {
		if (!v.providers[v.primaryProvider].primaryModel)
			ctx.addIssue({ code: 'custom', message: 'The primary provider needs an enabled primary model' });
		if (v.providerFallback && analysisProviders.some(p => !v.providers[p].primaryModel))
			ctx.addIssue({
				code: 'custom',
				message: 'Configure an enabled primary model for both providers before enabling provider fallback'
			});
	});
export function validateAnalysisSettings(value: unknown): AnalysisSettings {
	const result = settingsSchema.safeParse(value);
	if (!result.success) throw new BadRequestException(result.error.issues.map(i => i.message).join('; '));
	return result.data;
}
export function defaultAnalysisSettings(model: string): AnalysisSettings {
	return {
		primaryProvider: 'gemini',
		providerFallback: false,
		retryLimit: 2,
		retryDelaySeconds: 5,
		providers: {
			gemini: { primaryModel: model, models: [{ id: model, enabled: true }] },
			openai: { primaryModel: null, models: [] }
		}
	};
}
@Injectable()
export class AnalysisSettingsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly settings: AppSettingsService
	) {}
	async get(): Promise<AnalysisSettings> {
		const saved = await readConfiguration(this.prisma, 'analysis_settings');
		return Object.keys(saved).length
			? validateAnalysisSettings(saved)
			: validateAnalysisSettings(defaultAnalysisSettings((await this.settings.analysisModel()).model));
	}
	async save(value: unknown) {
		const validated = validateAnalysisSettings(value);
		await this.prisma.$transaction(tx =>
			writeConfiguration(
				tx,
				'analysis_settings',
				validated as unknown as Record<string, unknown>,
				undefined,
				true
			)
		);
		return validated;
	}
}
