import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService, type AuthRealm } from './services/token.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
	protected readonly realm: AuthRealm = 'user';
	constructor(protected readonly tokens: TokenService) {}
	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
		if (!match) throw new UnauthorizedException();
		request.user = await this.tokens.verifyAccessToken(match[1], this.realm);
		return true;
	}
}

@Injectable()
export class AdminAuthGuard extends AuthGuard {
	protected readonly realm: AuthRealm = 'admin';
	constructor(tokens: TokenService) {
		super(tokens);
	}
}
