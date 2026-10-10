import { Module } from '@nestjs/common';
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
@Module({
  imports: [
    UserModule,
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: { expiresIn: '60s' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    EmailService,
    PasswordHasher,
    PrismaService,
    Resend,
    OtpService,
    PendingRegistrationService,
  ],
})
export class AuthModule {}
