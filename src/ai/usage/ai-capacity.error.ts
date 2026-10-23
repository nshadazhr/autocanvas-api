export class AiCapacityError extends Error {
	constructor(
		public readonly nextRetryAt: Date,
		message = 'AI usage is temporarily limited. Your job will retry automatically.'
	) {
		super(message);
		this.name = 'AiCapacityError';
	}
}
