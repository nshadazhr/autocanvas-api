import {
  Injectable,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { randomInt } from 'node:crypto';

@Injectable()
export class OtpService {
  constructor(private readonly passwordHasher: PasswordHasher) {}

  readonly OTP_EXPIRY_MS = 10 * 60 * 1000;
  readonly OTP_COOLDOWN_MS = 60 * 1000;
  readonly OTP_WINDOW_MS = 60 * 60 * 1000;
  readonly MAX_OTP_SENDS = 5;
  readonly MAX_OTP_ATTEMPTS = 5;

  getOtpExpiryDate(now: Date): Date {
    return new Date(now.getTime() + this.OTP_EXPIRY_MS);
  }

  getRemainingCooldownSeconds(lastSentAt: Date, now: Date): number {
    const elapsed = now.getTime() - lastSentAt.getTime();

    return Math.max(0, Math.ceil((this.OTP_COOLDOWN_MS - elapsed) / 1000));
  }

  isOtpWindowActive(windowStart: Date | null, now: Date): boolean {
    return (
      windowStart !== null &&
      now.getTime() - windowStart.getTime() < this.OTP_WINDOW_MS
    );
  }

  isOtpExpired(expiresAt: Date): boolean {
    return expiresAt.getTime() <= Date.now();
  }

  generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }

  async hashOtp(otp: string): Promise<string> {
    return this.passwordHasher.hash(otp);
  }

  async verifyOtp(otp: string, otpHash: string): Promise<boolean> {
    return this.passwordHasher.verify(otp, otpHash);
  }

  validateResendCooldown(lastSentAt: Date | null, now: Date): void {
    if (!lastSentAt) return;

    const remainingSeconds = this.getRemainingCooldownSeconds(lastSentAt, now);

    if (remainingSeconds > 0) {
      throw new HttpException(
        `Please wait ${remainingSeconds} seconds before requesting another OTP`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  validateOtpSendLimit(windowActive: boolean, sendCount: number): void {
    if (windowActive && sendCount >= this.MAX_OTP_SENDS) {
      throw new HttpException(
        'OTP request limit reached. Please try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  validateOtpVerification(expiresAt: Date, attemptCount: number): void {
    if (this.isOtpExpired(expiresAt)) {
      throw new BadRequestException('OTP has expired');
    }

    if (attemptCount >= this.MAX_OTP_ATTEMPTS) {
      throw new HttpException(
        'Too many incorrect OTP attempts',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  calculateOtpSendMetadata(
    now: Date,
    windowActive: boolean,
    previousWindow: Date | null,
    previousSendCount: number,
  ) {
    const nextSendCount = windowActive ? previousSendCount + 1 : 1;

    const nextWindowStart =
      windowActive && previousWindow ? previousWindow : now;

    return {
      nextSendCount,
      nextWindowStart,
    };
  }
}
