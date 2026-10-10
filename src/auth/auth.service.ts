import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginDto, RegisterDto } from './dto/register.dto.js';
import { UserService } from '../user/user.service.js';
import { PasswordHasher } from '@nestjs/authentication';
import { TokenService } from './services/token.service.js';
import { OtpService } from './services/otp.service.js';
import { EmailService } from './services/email.service.js';
import { PendingRegistrationService } from './services/pending-registration.service.js';
@Injectable()
export class AuthService {
  constructor(
    private readonly emailService: EmailService,
    private readonly userService: UserService,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenService: TokenService,
    private readonly otpService: OtpService,
    private readonly pendingRegistrationService: PendingRegistrationService,
  ) {}

  async getUniqueEmail(email: string) {
    const uniqueEmail = await this.userService.getUniqueEmail(email);
    return uniqueEmail;
  }

  async register(registerDto: RegisterDto) {
    const email = registerDto.email.trim().toLowerCase();
    const existingUser = await this.getUniqueEmail(email);
    if (existingUser) {
      throw new ConflictException(`${existingUser.email} Email Already Exist`);
    }
    return this.issueRegistrationOtp(email, registerDto);
  }

  async login(loginDto: LoginDto) {
    const filteredUniqueEmail = await this.getUniqueEmail(loginDto.email);
    if (!filteredUniqueEmail) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const validPassword = await this.passwordHasher.verify(
      loginDto.password,
      filteredUniqueEmail.password,
    );
    if (!validPassword) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const payload = {
      id: filteredUniqueEmail.id,
      email: filteredUniqueEmail.email,
    };
    const { access_token, refresh_token } =
      await this.tokenService.generateTokens(payload);

    const { password, ...safeUser } = filteredUniqueEmail;
    const { id, name, email } = safeUser;
    return {
      user: {
        id,
        name,
        email,
      },
      access_token,
      refresh_token,
    };
  }

  async refreshAccessToken(refreshToken: string) {
    return this.tokenService.refreshAccessToken(refreshToken);
  }

  async verifyEmailOtp(email: string, otp: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const pending =
      await this.pendingRegistrationService.findByEmail(normalizedEmail);

    if (!pending) {
      throw new BadRequestException('Invalid or expired verification request');
    }

    this.otpService.validateOtpVerification(
      pending.expires_at,
      pending.attempt_count,
    );

    const isOtpValid = await this.otpService.verifyOtp(otp, pending.otp_hash);
    if (!isOtpValid) {
      await this.pendingRegistrationService.incrementOtpAttempts(
        pending.id,
        pending.otp_hash,
      );
      throw new BadRequestException('Invalid OTP');
    }
    
    const user = await this.pendingRegistrationService.createVerifiedUser(
      pending,
      this.otpService.MAX_OTP_ATTEMPTS,
    );

    const payload = {
      id: user.id,
      email: user.email,
    };

    const { access_token, refresh_token } =
      await this.tokenService.generateTokens(payload);

    return {
      success: true,
      message: 'Email verified successfully',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      access_token,
      refresh_token,
    };
  }
  async resendEmailOtp(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    return this.issueRegistrationOtp(email);
  }
  // Shared OTP logic for both registration and resend.
  private async issueRegistrationOtp(email: string, registerDto?: RegisterDto) {
    const now = new Date();
    if (!process.env.RESEND_API_KEY) {
      throw new InternalServerErrorException(
        'RESEND_API_KEY is not configured',
      );
    }
    const existingRegistrationPending = await this.pendingRegistrationService.findByEmail(email);
    // Resend must never create a new registration.
    if (!existingRegistrationPending && !registerDto) {
      throw new BadRequestException(
        'Pending registration not found. Please register again',
      );
    }
    // Cooldown: 60 seconds between successful OTP sends.
    this.otpService.validateResendCooldown(
      existingRegistrationPending?.last_sent_at ?? null,
      now,
    );

    const previousWindow = existingRegistrationPending?.window_start;
    const windowActive = this.otpService.isOtpWindowActive(
      previousWindow ?? null,
      now,
    );
    this.otpService.validateOtpSendLimit(
      windowActive,
      existingRegistrationPending?.send_count ?? 0,
    );
    const otp = this.otpService.generateOtp();
    const otpHash = await this.otpService.hashOtp(otp);
    const expiresAt = this.otpService.getOtpExpiryDate(now);

    const { nextSendCount, nextWindowStart } =
      this.otpService.calculateOtpSendMetadata(
        now,
        windowActive,
        previousWindow ?? null,
        existingRegistrationPending?.send_count ?? 0,
      );
    // Preserve original name and password on an existing pending record.
    const pendingRegistration = existingRegistrationPending
      ? await this.pendingRegistrationService.updatePendingOtp(
          email,
          otpHash,
          expiresAt,
        )
      : await this.pendingRegistrationService.createPendingRegistration({
          name: registerDto!.name,
          email,
          passwordHash: await this.passwordHasher.hash(registerDto!.password),
          otpHash,
          expiresAt,
        });
    try {
      await this.emailService.sendRegistrationOtp(
        pendingRegistration.email,
        otp,
      );
      await this.pendingRegistrationService.updateOtpSendMetadata(
        pendingRegistration.id,
        otpHash,
        now,
        nextSendCount,
        nextWindowStart,
      );
      return {
        success: true,
        message:
          'OTP sent successfully. Please check your email for the verification code.',
        email: pendingRegistration.email,
        expiresIn: 600,
      };
    } catch (error) {
      // Preserve the original rollback behavior on failure.
      await this.pendingRegistrationService.rollbackOtp(
        pendingRegistration.id,
        otpHash,
        existingRegistrationPending,
      );
      if (error instanceof InternalServerErrorException) throw error;
      console.error('OTP registration error:', error);
      throw new InternalServerErrorException(
        'Unable to send verification email. Please try again',
      );
    }
  }
}
