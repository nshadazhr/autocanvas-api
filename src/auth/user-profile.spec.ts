import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { UserService } from '../user/user.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function setup(profile: { id: number; name: string | null; email: string } | null) {
	const findUnique = vi.fn().mockResolvedValue(profile);
	const users = new UserService({ user: { findUnique } } as unknown as PrismaService);
	const service = new AuthService(undefined as never, users, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
	return { controller: new AuthController(service), findUnique };
}

describe('User profile after session restoration', () => {
	it('loads the saved name by authenticated ID, rather than returning name-less token claims', async () => {
		const profile = { id: 17, name: 'Saved User', email: 'profile@example.test' };
		const { controller, findUnique } = setup(profile);
		expect(await controller.getProfile({ user: { id: 17 } })).toEqual(profile);
		expect(findUnique).toHaveBeenCalledWith({ where: { id: 17 }, select: { id: true, name: true, email: true } });
		findUnique.mockResolvedValueOnce({ ...profile, name: 'Updated User' });
		expect((await controller.getProfile({ user: { id: 17 } }))?.name).toBe('Updated User');
	});
	it('preserves null names for accounts that genuinely have no saved name', async () => {
		const profile = { id: 17, name: null, email: 'profile@example.test' };
		expect(await setup(profile).controller.getProfile({ user: { id: 17 } })).toEqual(profile);
	});
	it('rejects a missing/deleted user instead of returning token claims', async () => {
		await expect(setup(null).controller.getProfile({ user: { id: 17 } })).rejects.toBeInstanceOf(UnauthorizedException);
	});
});
