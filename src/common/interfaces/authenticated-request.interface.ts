import type { Request } from 'express';

export interface AuthenticatedRequest extends Request {
	user: {
		id: number;
		email: string;
		realm?: 'user' | 'admin';
		sessionId?: string;
	};
}
