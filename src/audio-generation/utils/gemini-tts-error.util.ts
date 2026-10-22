export type GeminiTtsErrorType = 'SAFETY' | 'NO_AUDIO' | 'QUOTA' | 'RATE_LIMIT' | 'NETWORK' | 'UNKNOWN';

type ErrorDetails = {
	message?: unknown;
	code?: unknown;
	status?: unknown;
	finishReason?: unknown;
	cause?: unknown;
	response?: {
		status?: unknown;
		data?: unknown;
	};
};

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === 'string') {
		return error;
	}

	if (error && typeof error === 'object') {
		const details = error as ErrorDetails;

		if (typeof details.message === 'string') {
			return details.message;
		}
	}

	return String(error);
}

export function classifyGeminiTtsError(error: unknown): GeminiTtsErrorType {
	const details = error && typeof error === 'object' ? (error as ErrorDetails) : null;

	const message = getErrorMessage(error);

	const code = String(details?.code ?? '');
	const status = String(details?.status ?? details?.response?.status ?? '');

	const combined = `${message} ${code} ${status}`;

	// Quota or rate limit: never trigger neutral fallback
	if (/\b429\b|RESOURCE_EXHAUSTED|quota exceeded|quota exhausted/i.test(combined)) {
		return 'QUOTA';
	}

	if (/\bRATE_LIMIT\b|too many requests/i.test(combined)) {
		return 'RATE_LIMIT';
	}

	// Gemini explicitly rejected audio generation for safety
	if (/\bSAFETY\b|CONTENT_ERROR|PROHIBITED_CONTENT|BLOCKLIST/i.test(combined)) {
		return 'SAFETY';
	}

	// Gemini completed without an audio payload
	if (/Gemini returned no audio/i.test(combined)) {
		return 'NO_AUDIO';
	}

	if (/\bECONNRESET\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bECONNREFUSED\b|network error|fetch failed/i.test(combined)) {
		return 'NETWORK';
	}

	return 'UNKNOWN';
}

export function shouldRetryWithNeutralPrompt(error: unknown): boolean {
	const type = classifyGeminiTtsError(error);

	return type === 'SAFETY';
}
