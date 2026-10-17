export class GeminiKeysUnavailableError extends Error {
	constructor(
		message: string,
		public readonly nextRetryAt: Date | null
	) {
		super(message);
		this.name = 'GeminiKeysUnavailableError';

		Object.setPrototypeOf(this, GeminiKeysUnavailableError.prototype);
	}
}
