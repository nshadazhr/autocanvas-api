export const analysisProviders = ['gemini', 'openai'] as const;
export type AnalysisProvider = (typeof analysisProviders)[number];
export interface AnalysisModel {
	id: string;
	enabled: boolean;
}
export interface AnalysisProviderSettings {
	primaryModel: string | null;
	models: AnalysisModel[];
}
export interface AnalysisSettings {
	primaryProvider: AnalysisProvider;
	providerFallback: boolean;
	retryLimit: number;
	retryDelaySeconds: number;
	providers: Record<AnalysisProvider, AnalysisProviderSettings>;
}
export interface AnalysisStep {
	provider: AnalysisProvider;
	model: string;
	delayMs: number;
	kind: 'INITIAL' | 'MODEL_FALLBACK' | 'PROVIDER_FALLBACK' | 'PRIMARY_RETRY';
}
