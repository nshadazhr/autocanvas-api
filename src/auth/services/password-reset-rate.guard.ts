import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Separate persistent buckets; reset traffic must not consume password-login attempts. */
@Injectable()
export class PasswordResetRateGuard implements CanActivate {
	constructor(private readonly prisma: PrismaService) {}
	async canActivate(context: ExecutionContext) {
		const http = context.switchToHttp();
		const request = http.getRequest();
		const forgot = request.route?.path?.endsWith('/forgot-password');
		const kind = forgot ? 'reset-request' : 'reset-submit';
		const now = Date.now();
		const windowMs = 15 * 60_000;
		const start = Math.floor(now / windowMs) * windowMs;
		const expiresAt = new Date(start + windowMs);
		const hash = (value: string) => createHash('sha256').update(value).digest('hex');
		const email =
			typeof request.body?.email === 'string'
				? request.body.email.trim().toLowerCase().slice(0, 254)
				: 'invalid';
		const rules = [
			{ key: `${kind}:ip:${hash(request.ip ?? 'unknown')}:${start}`, max: forgot ? 20 : 30 },
			...(forgot ? [{ key: `${kind}:email:${hash(email)}:${start}`, max: 3 }] : [])
		];
		await this.prisma.$transaction(
			async tx => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73128,1)`;
				const buckets = await tx.authRateBucket.findMany({
					where: { key: { in: rules.map(rule => rule.key) } }
				});
				if (
					rules.some(
						rule => (buckets.find(bucket => bucket.key === rule.key)?.attempts ?? 0) >= rule.max
					)
				) {
					http.getResponse().setHeader(
						'Retry-After',
						String(Math.ceil((expiresAt.getTime() - now) / 1000))
					);
					throw new HttpException(
						'Too many password reset attempts. Please try later.',
						HttpStatus.TOO_MANY_REQUESTS
					);
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
