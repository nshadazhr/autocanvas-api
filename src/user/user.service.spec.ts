import { describe, expect, it, vi } from 'vitest';
import { UserService } from './user.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

describe('UserService response boundaries', () => {
	it('restores a profile with an explicit public-field allowlist', async () => {
		const profile = { id: 17, name: 'Fixture', email: 'fixture@example.test' };
		const findUnique = vi.fn().mockResolvedValue(profile);
		const service = new UserService({ user: { findUnique } } as unknown as PrismaService);
		expect(await service.getPublicProfile(17)).toEqual(profile);
		expect(findUnique).toHaveBeenCalledWith({ where: { id: 17 }, select: { id: true, name: true, email: true } });
	});
	it('returns null for a missing account so callers can reject restoration', async () => {
		const findFirst = vi.fn().mockResolvedValue(null);
		const service = new UserService({ user: { findFirst } } as unknown as PrismaService);
		expect(await service.getUniqueEmail('missing@example.test')).toBeNull();
		expect(findFirst).toHaveBeenCalledWith({ where: { email: 'missing@example.test' } });
	});
});
