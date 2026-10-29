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
	storage: { cleanupEnabled: true },
	security: { adminLoginAccountLimit: 5, adminLoginIpLimit: 30, loginAccountLimit: 10, loginIpLimit: 60 },
	processing: {
		maxRecoveryAttempts: 3,
		recoveryRetryDelayMs: 60000,
		retryScanIntervalMs: 30000,
		globalRequestsPerMinute: 10,
		globalRequestsPerDay: 300,
		userRequestsPerMinute: 5,
		userRequestsPerDay: 100,
		globalCharactersPerDay: 500000,
		userCharactersPerDay: 100000
	},
	pricing: { analysisCredits: 0, audioCreditsPer1000Characters: 0, welcomeCredits: 0 }
};
export type RuntimeSection = keyof typeof runtimeDefaults;
export type RuntimeValues = Record<string, string | number | boolean>;

export const processingEnvironment = {
	maxRecoveryAttempts: 'AUDIO_MAX_RECOVERY_ATTEMPTS',
	recoveryRetryDelayMs: 'AUDIO_RECOVERY_RETRY_DELAY_MS',
	retryScanIntervalMs: 'AUDIO_RETRY_SCAN_INTERVAL_MS',
	globalRequestsPerMinute: 'AI_GLOBAL_REQUESTS_PER_MINUTE',
	globalRequestsPerDay: 'AI_GLOBAL_REQUESTS_PER_DAY',
	userRequestsPerMinute: 'AI_USER_REQUESTS_PER_MINUTE',
	userRequestsPerDay: 'AI_USER_REQUESTS_PER_DAY',
	globalCharactersPerDay: 'AI_GLOBAL_CHARACTERS_PER_DAY',
	userCharactersPerDay: 'AI_USER_CHARACTERS_PER_DAY'
} as const;

export const loginSecurityEnvironment = {
	adminLoginAccountLimit: 'ADMIN_LOGIN_ACCOUNT_LIMIT',
	adminLoginIpLimit: 'ADMIN_LOGIN_IP_LIMIT',
	loginAccountLimit: 'LOGIN_ACCOUNT_LIMIT',
	loginIpLimit: 'LOGIN_IP_LIMIT'
} as const;
