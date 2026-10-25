export const runtimeDefaults = {
	'web-settings': { showStats: true, showChannels: true, defaultLanguage: 'en' },
	features: {
		maintenanceMode: false,
		audioEnabled: true,
		analysisEnabled: true,
		scriptEnabled: true,
		geminiEnabled: true,
		openaiEnabled: true
	},
	models: { outlineModel: 'gpt-4.1' },
	processing: { maxRecoveryAttempts: 3, recoveryRetryDelayMs: 60000 },
	pricing: { analysisCredits: 0, audioCreditsPer1000Characters: 0, welcomeCredits: 0 }
};
export type RuntimeSection = keyof typeof runtimeDefaults;
export type RuntimeValues = Record<string, string | number | boolean>;
