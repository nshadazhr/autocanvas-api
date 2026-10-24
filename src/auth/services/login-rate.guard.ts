import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
@Injectable()
export class LoginRateGuard implements CanActivate {
	constructor(
		private readonly prisma: PrismaService,
		private readonly config: ConfigService
	) {}
	private limit(key: string, fallback: number) {
		const value = Number(this.config.get(key));
		return Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}
	async canActivate(context: ExecutionContext): Promise<boolean> {
		const http = context.switchToHttp();
		const request = http.getRequest();
		const admin = request.route?.path?.includes('/admin/') ?? false;
		const realm = admin ? 'admin' : 'user';
		const windowMs = 15 * 60_000;
		const now = Date.now();
		const start = Math.floor(now / windowMs) * windowMs;
		const expiresAt = new Date(start + windowMs);
		const hash = (value: string) => createHash('sha256').update(value).digest('hex');
		const email =
			typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase().slice(0, 320) : 'invalid';
		// Use Express's peer IP. Do not trust arbitrary X-Forwarded-For headers.
		const rules = [
			{
				key: `${realm}:ip:${hash(request.ip ?? 'unknown')}:${start}`,
				max: this.limit(admin ? 'ADMIN_LOGIN_IP_LIMIT' : 'LOGIN_IP_LIMIT', admin ? 30 : 60)
			},
			{
				key: `${realm}:email:${hash(email)}:${start}`,
				max: this.limit(admin ? 'ADMIN_LOGIN_ACCOUNT_LIMIT' : 'LOGIN_ACCOUNT_LIMIT', admin ? 5 : 10)
			}
		];
		await this.prisma.$transaction(
			async tx => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73128,0)`;
				const buckets = await tx.authRateBucket.findMany({ where: { key: { in: rules.map(r => r.key) } } });
				if (rules.some(r => (buckets.find(b => b.key === r.key)?.attempts ?? 0) >= r.max)) {
					http.getResponse().setHeader('Retry-After', String(Math.ceil((expiresAt.getTime() - now) / 1000)));
					throw new HttpException('Too many login attempts. Please try later.', HttpStatus.TOO_MANY_REQUESTS);
				}
				for (const rule of rules)
					await tx.authRateBucket.upsert({
						where: { key: rule.key },
						create: { key: rule.key, attempts: 1, expiresAt },
						update: { attempts: { increment: 1 } }
					});
				await tx.authRateBucket.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
			},
			{ maxWait: 10_000, timeout: 15_000 }
		);
		return true;
	}
}
