export function safeAiError(error: unknown): string {
	const message = error instanceof Error ? error.message : 'AI request failed';
	return message
		.replace(/AIza[\w-]+/g, '[redacted]')
		.replace(/([?&](?:key|api_key)=)[^&\s"']+/gi, '$1[redacted]')
		.replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
		.slice(0, 500);
}
