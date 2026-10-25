/** Provider 429: job scheduling may retry the same key later. */
export class ProviderRateLimitError extends Error {
	constructor(
		message: string,
		public readonly nextRetryAt: Date
	) {
		super(message);
		this.name = 'ProviderRateLimitError';
	}
}
