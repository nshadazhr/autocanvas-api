import {
	CanActivate,
	ExecutionContext,
	HttpException,
	HttpStatus,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
@Injectable()
export class LoginRateGuard implements CanActivate {
	constructor(
		private readonly prisma: PrismaService,
		private readonly settings: AppSettingsService
	) {}
	async canActivate(context: ExecutionContext): Promise<boolean> {
		const http = context.switchToHttp();
		const request = http.getRequest();
		const admin = request.route?.path?.includes('/admin/') ?? false;
		const realm = admin ? 'admin' : 'user';
		const { values } = await this.settings.section('security');
		const ipLimit = values[admin ? 'adminLoginIpLimit' : 'loginIpLimit'];
		const accountLimit = values[admin ? 'adminLoginAccountLimit' : 'loginAccountLimit'];
		if (
			[ipLimit, accountLimit].some(
				value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1000000
			)
		)
			throw new ServiceUnavailableException('Login security settings are invalid');
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
				max: Number(ipLimit)
			},
			{
				key: `${realm}:email:${hash(email)}:${start}`,
				max: Number(accountLimit)
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
