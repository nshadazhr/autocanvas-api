import { describe, expect, it } from 'vitest';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';

describe('Legacy profile alias', () => {
	it('uses the guard-provided identity rather than a caller-supplied body', () => {
		const controller = new ProfileController(new ProfileService());
		const user = { id: 17, email: 'fixture@example.test' };
		expect(controller.getProfile({ user, body: { id: 99 } })).toBe(user);
	});
});
