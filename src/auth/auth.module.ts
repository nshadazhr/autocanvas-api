import { AppSettingsModule } from '../settings/app-settings.module.js';
import { AdminRolesController } from './admin-roles.controller.js';
import { AdminRoleService } from './services/admin-role.service.js';
import { SuperAdminGuard } from './services/superadmin.guard.js';
import { AuthGuard, AdminAuthGuard } from './auth.guard.js';
import { AuthOriginGuard } from './services/auth-origin.guard.js';
import { LoginRateGuard } from './services/login-rate.guard.js';
import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { UserModule } from '../user/user.module.js';
import { PasswordHasher } from '@nestjs/authentication';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from './constants.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Resend } from 'resend';
import { TokenService } from './services/token.service.js';
import { EmailService } from './services/email.service.js';
import { OtpService } from './services/otp.service.js';
import { PendingRegistrationService } from './services/pending-registration.service.js';
import { GoogleAuthService } from './services/google-auth.service.js';
import { AdminGuard } from './services/admin.guard.js';
import { PasswordResetController } from './password-reset.controller.js';
import { PasswordResetService } from './services/password-reset.service.js';
import { PasswordResetRateGuard } from './services/password-reset-rate.guard.js';
@Global()
@Module({
	imports: [
		AppSettingsModule,
		UserModule,
		JwtModule.register({
			global: true,
			secret: jwtConstants.secret,
			signOptions: { expiresIn: '15m' }
		})
	],
	controllers: [AuthController, AdminRolesController, PasswordResetController],
	providers: [
		AuthService,
		PasswordResetService,
		PasswordResetRateGuard,
		TokenService,
		EmailService,
		PasswordHasher,
		PrismaService,
		Resend,
		OtpService,
		PendingRegistrationService,
		GoogleAuthService,
		AdminRoleService,
		SuperAdminGuard,
		AdminGuard,
		AuthGuard,
		AdminAuthGuard,
		AuthOriginGuard,
		LoginRateGuard
	],
	exports: [TokenService, AuthGuard, AdminAuthGuard, AdminGuard, SuperAdminGuard]
})
export class AuthModule {}
