import { Body, Controller, Get, Post, UseGuards, Request, Res, UnauthorizedException } from '@nestjs/common';

import { LoginDto, RegisterDto, VerifyOtpDto, ResendOtpDto } from './dto/register.dto.js';

import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import type { Response } from 'express';
import { GoogleLoginDto } from './dto/google-login.dto.js';

@Controller('auth')
export class AuthController {
	constructor(private readonly authService: AuthService) {}

	private handleRefreshTokenCookie(res: Response, action: 'set' | 'clear', refreshToken?: string): void {
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

			res.cookie('refresh_token', refreshToken, {
				...cookieOptions,
				maxAge: 24 * 60 * 60 * 1000
			});
		} else {
			res.clearCookie('refresh_token', cookieOptions);
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

	@Post('login')
	async login(@Body() loginDto: LoginDto, @Res({ passthrough: true }) res: Response) {
		const result = await this.authService.login(loginDto);

		this.handleRefreshTokenCookie(res, 'set', result.refresh_token);

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

	@Post('logout')
	logout(@Res({ passthrough: true }) res: Response) {
		this.handleRefreshTokenCookie(res, 'clear');

		return {
			message: 'Logged out successfully'
		};
	}

	@UseGuards(AuthGuard)
	@Get('profile')
	getProfile(@Request() req: any) {
		return req.user;
	}
}
