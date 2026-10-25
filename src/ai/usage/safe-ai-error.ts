export function safeAiError(error: unknown): string {
	const message = error instanceof Error ? error.message : 'AI request failed';
	return message
		.replace(/AIza[\w-]+/g, '[redacted]')
		.replace(/([?&](?:key|api_key)=)[^&\s"']+/gi, '$1[redacted]')
		.replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
		.slice(0, 500);
}

/** Google can report invalid credentials as HTTP 400 rather than 401/403. */
export function isInvalidProviderKey(error: unknown): boolean {
	const message = error instanceof Error ? error.message : '';
	return /API_KEY_(?:INVALID|EXPIRED|SERVICE_BLOCKED)|API key (?:not valid|expired|is invalid)/i.test(message);
}
