import { AuthOriginGuard } from './services/auth-origin.guard.js';
import { LoginRateGuard } from './services/login-rate.guard.js';
import { Body, Controller, Get, Header, Post, UseGuards, Request, Res, UnauthorizedException } from '@nestjs/common';

import { LoginDto, RegisterDto, VerifyOtpDto, ResendOtpDto } from './dto/register.dto.js';

import { AuthService } from './auth.service.js';
import { AuthGuard, AdminAuthGuard } from './auth.guard.js';
import type { Response } from 'express';
import { GoogleLoginDto } from './dto/google-login.dto.js';
import { AdminGuard } from './services/admin.guard.js';

@Controller('auth')
@UseGuards(AuthOriginGuard)
export class AuthController {
	constructor(private readonly authService: AuthService) {}

	private handleRefreshTokenCookie(
		res: Response,
		action: 'set' | 'clear',
		refreshToken?: string,
		cookieName: 'refresh_token' | 'admin_refresh_token' = 'refresh_token'
	): void {
		const isProduction = process.env.NODE_ENV === 'production';

		const cookieOptions = {
			httpOnly: true,
			secure: isProduction,
			sameSite: isProduction ? ('none' as const) : ('lax' as const),
			path: '/'
		};

		if (action === 'set') {
			if (!refreshToken) {
				throw new Error('Refresh token is required');
			}

			res.cookie(cookieName, refreshToken, {
				...cookieOptions,
				maxAge: 24 * 60 * 60 * 1000
			});
		} else {
			res.clearCookie(cookieName, cookieOptions);
		}
	}

	@Post('register')
	register(@Body() registerDto: RegisterDto) {
		return this.authService.register(registerDto);
	}

	@Post('google')
	async googleLogin(@Body() googleLoginDto: GoogleLoginDto, @Res({ passthrough: true }) res: Response) {
		const { refresh_token, ...result } = await this.authService.googleLogin(googleLoginDto.idToken);

		this.handleRefreshTokenCookie(res, 'set', refresh_token);

		return result;
	}

	@Post('resend-otp')
	resendEmailOtp(@Body() dto: ResendOtpDto) {
		return this.authService.resendEmailOtp(dto.email);
	}

	@Post('verify-email-otp')
	async verifyEmailOtp(@Body() verifyOtpDto: VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
		const result = await this.authService.verifyEmailOtp(verifyOtpDto.email, verifyOtpDto.otp);

		this.handleRefreshTokenCookie(res, 'set', result.refresh_token);

		return {
			success: result.success,
			message: result.message,
			user: result.user,
			access_token: result.access_token
		};
	}

	@UseGuards(LoginRateGuard)
	@Post('login')
	async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response) {
		const result = await this.authService.login(loginDto);

		this.handleRefreshTokenCookie(res, 'set', result.refresh_token);

		return {
			user: result.user,
			access_token: result.access_token
		};
	}

	@UseGuards(LoginRateGuard)
	@Post('admin/login')
	async adminLogin(@Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response) {
		const result = await this.authService.login(loginDto, true);

		this.handleRefreshTokenCookie(res, 'set', result.refresh_token, 'admin_refresh_token');

		return {
			user: result.user,
			access_token: result.access_token
		};
	}

	@Post('refresh')
	refresh(@Request() req: any) {
		const refreshToken = req.cookies?.refresh_token;

		if (!refreshToken) {
			throw new UnauthorizedException('Refresh token not found');
		}

		return this.authService.refreshAccessToken(refreshToken);
	}

	@Post('admin/refresh')
	async adminRefresh(@Request() req: any) {
		const refreshToken = req.cookies?.admin_refresh_token;

		if (!refreshToken) {
			throw new UnauthorizedException('Admin refresh token not found');
		}

		return this.authService.refreshAdminAccessToken(refreshToken);
	}

	@UseGuards(AdminAuthGuard, AdminGuard)
	@Get('admin/check')
	checkAdmin(@Request() req: any) {
		return {
			success: true,
			user: req.adminUser
		};
	}

	@Post('logout')
	async logout(@Request() req: any, @Res({ passthrough: true }) res: Response) {
		await this.authService.logout(req.cookies?.refresh_token);
		this.handleRefreshTokenCookie(res, 'clear');

		return {
			message: 'Logged out successfully'
		};
	}

	@Post('admin/logout')
	async adminLogout(@Request() req: any, @Res({ passthrough: true }) res: Response) {
		await this.authService.logout(req.cookies?.admin_refresh_token, true);
		this.handleRefreshTokenCookie(res, 'clear', undefined, 'admin_refresh_token');

		return {
			message: 'Admin logged out successfully'
		};
	}

	@UseGuards(AuthGuard)
	@Get('profile')
	@Header('Cache-Control', 'private, no-store')
	getProfile(@Request() req: { user: { id: number } }) {
		return this.authService.getProfile(req.user.id);
	}
}
