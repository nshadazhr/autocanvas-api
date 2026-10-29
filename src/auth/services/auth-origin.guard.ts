import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { authAllowedOrigins } from './auth-origins.js';
@Injectable()
export class AuthOriginGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest();
		if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
		const origin = request.headers.origin;
		const realm = request.route?.path?.includes('/admin/') ? 'admin' : 'user';
		if (
			(origin && !authAllowedOrigins(process.env, realm).includes(origin)) ||
			(!origin && request.headers['sec-fetch-site'] === 'cross-site')
		)
			throw new ForbiddenException('Request origin is not allowed');
		return true;
	}
}
