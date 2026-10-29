import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EmailService } from './email.service.js';
import { authAllowedOrigins } from './auth-origins.js';

export const RESET_TOKEN_TTL_MS = 30 * 60_000;
export const RESET_REQUEST_MESSAGE = 'If an eligible account exists, you will receive a password reset link.';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class PasswordResetService {
	private readonly logger = new Logger(PasswordResetService.name);
	constructor(
		private readonly prisma: PrismaService,
		private readonly email: EmailService,
		private readonly passwords: PasswordHasher
	) {}

	async request(email: string) {
		if (!process.env.RESEND_API_KEY?.trim())
			throw new InternalServerErrorException('Email delivery is unavailable');
		const origin = authAllowedOrigins(process.env, 'user')[0];
		if (!origin) throw new InternalServerErrorException('Password reset origin is not configured');
		const user = await this.prisma.user.findUnique({
			where: { email: email.trim().toLowerCase() },
			select: { id: true, email: true, password: true, email_verified_at: true }
		});
		if (!user?.password || !user.email_verified_at) return { message: RESET_REQUEST_MESSAGE };
		const token = randomBytes(32).toString('hex');
		const tokenHash = digest(token);
		const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
		await this.prisma.passwordReset.upsert({
			where: { userId: user.id },
			create: { userId: user.id, tokenHash, expiresAt },
			update: { tokenHash, expiresAt, createdAt: new Date() }
		});
		const link = new URL('/reset-password', origin);
		link.hash = new URLSearchParams({ token }).toString();
		try {
			await this.email.sendPasswordReset(user.email, link.href);
		} catch {
			// Do not leak account eligibility or raw tokens/provider errors in responses/logs.
			await this.prisma.passwordReset.deleteMany({ where: { userId: user.id, tokenHash } });
			this.logger.warn('Password reset email could not be delivered');
		}
		return { message: RESET_REQUEST_MESSAGE };
	}

	async reset(token: string, password: string) {
		const tokenHash = digest(token);
		const invalid = () =>
			new BadRequestException({
				code: 'RESET_TOKEN_INVALID',
				message: 'This reset link is invalid or expired. Request a new link.'
			});
		const record = await this.prisma.passwordReset.findUnique({ where: { tokenHash } });
		if (!record || record.expiresAt.getTime() <= Date.now()) throw invalid();
		const passwordHash = await this.passwords.hash(password);
		await this.prisma.$transaction(async tx => {
			// Atomic consumption: only one concurrent submission can change the password.
			const consumed = await tx.passwordReset.deleteMany({
				where: { userId: record.userId, tokenHash, expiresAt: { gt: new Date() } }
			});
			if (consumed.count !== 1) throw invalid();
			await tx.user.update({ where: { id: record.userId }, data: { password: passwordHash } });
			await tx.authSession.updateMany({
				where: { userId: record.userId, revokedAt: null },
				data: { revokedAt: new Date() }
			});
		});
		return { message: 'Password updated. Please sign in again.' };
	}
}
