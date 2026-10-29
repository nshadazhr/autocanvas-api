import { Injectable, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';

export type AuthRealm = 'user' | 'admin';
interface TokenPayload {
	id: number;
	email: string;
}
interface SessionClaims extends TokenPayload {
	sid: string;
	kind: 'access' | 'refresh';
	aud: string;
}
const audience = (realm: AuthRealm) => `autocanvas-${realm}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class TokenService implements OnModuleInit {
	constructor(
		private readonly jwtService: JwtService,
		private readonly prisma: PrismaService
	) {}
	onModuleInit() {
		this.refreshSecret();
	}
	private refreshSecret() {
		const secret = process.env.JWT_REFRESH_SECRET;
		if (!secret?.trim()) throw new Error('JWT_REFRESH_SECRET must be configured');
		return secret;
	}
	private async access(payload: TokenPayload, sid: string, realm: AuthRealm) {
		return this.jwtService.signAsync(
			{ id: payload.id, email: payload.email, sid, kind: 'access' },
			{ audience: audience(realm), expiresIn: '15m' }
		);
	}
	async generateTokens(payload: TokenPayload, realm: AuthRealm = 'user') {
		const sid = randomUUID();
		const refresh_token = await this.jwtService.signAsync(
			{ id: payload.id, email: payload.email, sid, kind: 'refresh' },
			{ secret: this.refreshSecret(), audience: audience(realm), expiresIn: '1d' }
		);
		const access_token = await this.access(payload, sid, realm);
		await this.prisma.authSession.create({
			data: {
				id: sid,
				userId: payload.id,
				realm,
				refreshHash: digest(refresh_token),
				expiresAt: new Date(Date.now() + 86_400_000)
			}
		});
		return { access_token, refresh_token };
	}
	private validClaims(value: SessionClaims, kind: 'access' | 'refresh') {
		return (
			value &&
			Number.isSafeInteger(value.id) &&
			value.id > 0 &&
			typeof value.email === 'string' &&
			value.email.length > 0 &&
			typeof value.sid === 'string' &&
			/^[0-9a-f-]{36}$/i.test(value.sid) &&
			value.kind === kind
		);
	}
	private async session(payload: SessionClaims, realm: AuthRealm) {
		return this.prisma.authSession.findFirst({
			where: { id: payload.sid, userId: payload.id, realm, revokedAt: null, expiresAt: { gt: new Date() } },
			select: { id: true, refreshHash: true }
		});
	}
	async verifyAccessToken(token: string, realm: AuthRealm = 'user') {
		let payload: SessionClaims;
		try {
			payload = await this.jwtService.verifyAsync<SessionClaims>(token, { audience: audience(realm) });
		} catch {
			throw new UnauthorizedException('Invalid or expired access token');
		}
		if (!this.validClaims(payload, 'access') || !(await this.session(payload, realm)))
			throw new UnauthorizedException('Session expired. Please sign in again.');
		return { id: payload.id, email: payload.email, sessionId: payload.sid, realm };
	}
	async verifyRefreshToken(token: string, realm: AuthRealm = 'user') {
		const secret = this.refreshSecret();
		let payload: SessionClaims;
		try {
			payload = await this.jwtService.verifyAsync<SessionClaims>(token, { secret, audience: audience(realm) });
		} catch {
			throw new UnauthorizedException('Invalid or expired refresh token');
		}
		if (!this.validClaims(payload, 'refresh')) throw new UnauthorizedException('Invalid refresh token');
		const session = await this.session(payload, realm);
		const actual = Buffer.from(digest(token), 'hex');
		const expected = Buffer.from(session?.refreshHash ?? '', 'hex');
		if (!session || expected.length !== actual.length || !timingSafeEqual(expected, actual))
			throw new UnauthorizedException('Session expired. Please sign in again.');
		return payload;
	}
	async refreshAccessToken(token: string, realm: AuthRealm = 'user') {
		const payload = await this.verifyRefreshToken(token, realm);
		return this.generateAccessToken(payload, realm);
	}
	async generateAccessToken(payload: SessionClaims, realm: AuthRealm = 'user') {
		if (!(await this.session(payload, realm)))
			throw new UnauthorizedException('Session expired. Please sign in again.');
		return { access_token: await this.access(payload, payload.sid, realm) };
	}
	async revokeSession(token: string | undefined, realm: AuthRealm = 'user') {
		if (!token) return;
		let payload: SessionClaims;
		try {
			payload = await this.verifyRefreshToken(token, realm);
		} catch (error) {
			if (error instanceof UnauthorizedException) return;
			throw error;
		}
		await this.prisma.authSession.updateMany({
			where: { id: payload.sid, userId: payload.id, realm, revokedAt: null },
			data: { revokedAt: new Date() }
		});
	}
}
