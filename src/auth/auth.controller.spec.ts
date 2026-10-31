import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { AuthController } from './auth.controller.js';
import type { AuthService } from './auth.service.js';

function setup() {
	const login = vi
		.fn()
		.mockResolvedValue({ user: { id: 17 }, access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
	const refreshAccessToken = vi.fn();
	const controller = new AuthController({ login, refreshAccessToken } as unknown as AuthService);
	const response = { cookie: vi.fn(), clearCookie: vi.fn() };
	return { controller, login, refreshAccessToken, response, res: response as unknown as Response };
}

afterEach(() => vi.unstubAllEnvs());
describe('AuthController token transport', () => {
	it('keeps refresh tokens in HttpOnly cookies and out of the login JSON', async () => {
		vi.stubEnv('NODE_ENV', 'test');
		const { controller, res, response } = setup();
		const result = await controller.login({ email: 'fixture@example.test', password: 'fixture-input' }, res);
		expect(result).toEqual({ user: { id: 17 }, access_token: 'fixture-access' });
		expect(response.cookie).toHaveBeenCalledWith(
			'refresh_token',
			'fixture-refresh',
			expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'lax' })
		);
	});
	it('keeps admin login on its own secure production cookie/realm', async () => {
		vi.stubEnv('NODE_ENV', 'production');
		const { controller, login, res, response } = setup();
		const dto = { email: 'fixture@example.test', password: 'fixture-input' };
		await controller.adminLogin(dto, res);
		expect(login).toHaveBeenCalledWith(dto, true);
		expect(response.cookie).toHaveBeenCalledWith(
			'admin_refresh_token',
			'fixture-refresh',
			expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'none' })
		);
	});
	it('rejects absent refresh cookies without calling token refresh', () => {
		const { controller, refreshAccessToken } = setup();
		expect(() => controller.refresh({ cookies: {} })).toThrow(UnauthorizedException);
		expect(refreshAccessToken).not.toHaveBeenCalled();
	});
});
