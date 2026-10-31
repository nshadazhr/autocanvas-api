import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { AuthService } from './auth.service.js';
import type { UserService } from '../user/user.service.js';
import type { TokenService } from './services/token.service.js';
import type { EmailService } from './services/email.service.js';
import type { OtpService } from './services/otp.service.js';
import type { PendingRegistrationService } from './services/pending-registration.service.js';
import type { GoogleAuthService } from './services/google-auth.service.js';

function setup() {
	const users = { getUniqueEmail: vi.fn(), getPublicProfile: vi.fn() };
	const hasher = { verify: vi.fn().mockResolvedValue(true) };
	const tokens = {
		generateTokens: vi.fn().mockResolvedValue({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' })
	};
	const service = new AuthService(
		{} as EmailService,
		users as unknown as UserService,
		hasher as unknown as PasswordHasher,
		tokens as unknown as TokenService,
		{} as OtpService,
		{} as PendingRegistrationService,
		{} as GoogleAuthService
	);
	return { service, users, hasher, tokens };
}
const account = { id: 17, name: 'Fixture', email: 'fixture@example.test', role: 'USER', password: 'fixture-hash' };

describe('AuthService sign-in boundaries', () => {
	it('normalizes email and excludes password/role from the user-session response', async () => {
		const { service, users, tokens } = setup();
		users.getUniqueEmail.mockResolvedValue(account);
		const result = await service.login({ email: ' FIXTURE@EXAMPLE.TEST ', password: 'fixture-input' });
		expect(users.getUniqueEmail).toHaveBeenCalledWith(account.email);
		expect(result.user).toEqual({ id: 17, name: 'Fixture', email: account.email });
		expect(tokens.generateTokens).toHaveBeenCalledWith({ id: 17, email: account.email }, 'user');
	});
	it('rejects missing password accounts and incorrect passwords without issuing tokens', async () => {
		const { service, users, hasher, tokens } = setup();
		for (const value of [null, { ...account, password: null }, account]) {
			users.getUniqueEmail.mockResolvedValue(value);
			hasher.verify.mockResolvedValue(false);
			await expect(service.login({ email: account.email, password: 'wrong' })).rejects.toBeInstanceOf(
				UnauthorizedException
			);
		}
		expect(tokens.generateTokens).not.toHaveBeenCalled();
	});
	it('rejects USER access to admin login and uses a separate token realm for admins', async () => {
		const { service, users, tokens } = setup();
		users.getUniqueEmail.mockResolvedValue(account);
		await expect(service.login({ email: account.email, password: 'fixture-input' }, true)).rejects.toBeInstanceOf(
			UnauthorizedException
		);
		expect(tokens.generateTokens).not.toHaveBeenCalled();
		users.getUniqueEmail.mockResolvedValue({ ...account, role: 'ADMIN' });
		expect((await service.login({ email: account.email, password: 'fixture-input' }, true)).user.role).toBe(
			'ADMIN'
		);
		expect(tokens.generateTokens).toHaveBeenCalledWith({ id: 17, email: account.email }, 'admin');
	});
	it('rejects restoration when the underlying user no longer exists', async () => {
		const { service, users } = setup();
		users.getPublicProfile.mockResolvedValue(null);
		await expect(service.getProfile(17)).rejects.toBeInstanceOf(UnauthorizedException);
	});
});
