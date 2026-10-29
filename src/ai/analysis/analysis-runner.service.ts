import type { AnalysisSettings, AnalysisProvider, AnalysisStep } from './analysis.types.js';
import { analysisProviders } from './analysis.types.js';
import { classifyAnalysisError } from './analysis-errors.js';
/** One immutable configuration snapshot per job; execution/leases remain in the job service. */
export class AnalysisRun {
	current: AnalysisStep;
	private readonly queue: AnalysisStep[];
	private readonly blocked = new Set<AnalysisProvider>();
	private retries = 0;
	constructor(private readonly settings: AnalysisSettings) {
		this.settings = structuredClone(settings);
		settings = this.settings;
		const order = [
			settings.primaryProvider,
			...analysisProviders.filter(p => p !== settings.primaryProvider && settings.providerFallback)
		];
		this.queue = order.flatMap(provider => {
			const p = settings.providers[provider];
			const models = [
				p.primaryModel,
				...p.models.filter(m => m.enabled && m.id !== p.primaryModel).map(m => m.id)
			].filter((m): m is string => !!m);
			return models.map((model, index) => ({
				provider,
				model,
				delayMs: 0,
				kind:
					index === 0
						? provider === settings.primaryProvider
							? ('INITIAL' as const)
							: ('PROVIDER_FALLBACK' as const)
						: ('MODEL_FALLBACK' as const)
			}));
		});
		this.current = this.queue.shift()!;
	}
	afterFailure(error: unknown): AnalysisStep | null {
		const { kind } = classifyAnalysisError(error);
		if (!['BUSY', 'RATE_LIMITED', 'QUOTA_EXHAUSTED'].includes(kind)) return null;
		// A 429 may be shared across all models on this provider. Do not hammer it.
		if (kind !== 'BUSY') this.blocked.add(this.current.provider);
		while (this.queue.length) {
			const next = this.queue.shift()!;
			if (!this.blocked.has(next.provider)) return (this.current = next);
		}
		if (this.blocked.has(this.settings.primaryProvider) || this.retries >= this.settings.retryLimit) return null;
		this.retries++;
		return (this.current = {
			provider: this.settings.primaryProvider,
			model: this.settings.providers[this.settings.primaryProvider].primaryModel!,
			delayMs: this.settings.retryDelaySeconds * 1000,
			kind: 'PRIMARY_RETRY'
		});
	}
}
