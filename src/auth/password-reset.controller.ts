import { Body, Controller, Header, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto.js';
import { PasswordResetService } from './services/password-reset.service.js';
import { PasswordResetRateGuard } from './services/password-reset-rate.guard.js';
import { AuthOriginGuard } from './services/auth-origin.guard.js';

@Controller('auth')
@UseGuards(AuthOriginGuard, PasswordResetRateGuard)
export class PasswordResetController {
	constructor(private readonly resets: PasswordResetService) {}

	@Post('forgot-password')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	request(@Body() dto: ForgotPasswordDto) {
		return this.resets.request(dto.email);
	}

	@Post('reset-password')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	async reset(@Body() dto: ResetPasswordDto, @Res({ passthrough: true }) res: Response) {
		const result = await this.resets.reset(dto.token, dto.password);
		const production = process.env.NODE_ENV === 'production';
		const options = {
			path: '/',
			httpOnly: true,
			secure: production,
			sameSite: production ? ('none' as const) : ('lax' as const)
		};
		res.clearCookie('refresh_token', options);
		res.clearCookie('admin_refresh_token', options);
		return result;
	}
}
