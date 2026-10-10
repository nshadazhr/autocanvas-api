import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  Request,
  Res,
  UnauthorizedException,
 } from '@nestjs/common';
 import { LoginDto, RegisterDto, VerifyOtpDto, ResendOtpDto } from './dto/register.dto.js';
 import { AuthService } from './auth.service.js';
 import { AuthGuard } from './auth.guard.js';
 import type { Response } from 'express';
 @Controller('auth')
 export class AuthController {
   authService: AuthService;
   constructor(authService: AuthService) {
     this.authService = authService;
   }

   private setRefreshTokenCookie(res: Response, refreshToken: string): void {
     res.cookie('refresh_token', refreshToken, {
       httpOnly: true,
       secure: process.env.NODE_ENV === 'production',
       sameSite: 'lax',
       maxAge: 24 * 60 * 60 * 1000,
     });
   }

   @Post('register')
   register(@Body() registerDto: RegisterDto) {
     return this.authService.register(registerDto);
   }

   @Post('resend-otp')
   resendEmailOtp(@Body() dto: ResendOtpDto) {
     return this.authService.resendEmailOtp(dto.email);
   }

   @Post('verify-email-otp')
   async verifyEmailOtp(
     @Body() verifyOtpDto: VerifyOtpDto,
     @Res({ passthrough: true }) res: Response,
   ) {
     const result = await this.authService.verifyEmailOtp(
       verifyOtpDto.email,
       verifyOtpDto.otp,
     );

     this.setRefreshTokenCookie(res, result.refresh_token);

     return {
       success: result.success,
       message: result.message,
       user: result.user,
       access_token: result.access_token,
     };
   }

   @Post('login')
   async login(
     @Body() loginDto: LoginDto,
     @Res({ passthrough: true }) res: Response,
   ) {
     const result = await this.authService.login(loginDto);

     this.setRefreshTokenCookie(res, result.refresh_token);

     return {
       user: result.user,
       access_token: result.access_token,
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
     res.clearCookie('refresh_token', {
       httpOnly: true,
       secure: process.env.NODE_ENV === 'production',
       sameSite: 'lax',
       path: '/',
     });

     return {
       message: 'Logged out successfully',
     };
   }

   @UseGuards(AuthGuard)
   @Get('profile')
   getProfile(@Request() req: any) {
     return req.user;
   }
 }
 