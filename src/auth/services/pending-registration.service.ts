import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class PendingRegistrationService {
  constructor(private readonly prismaService: PrismaService) {}

  async findByEmail(email: string) {
    return this.prismaService.pendingRegistration.findUnique({
      where: { email },
    });
  }

  async incrementOtpAttempts(id: string, otpHash: string) {
    return this.prismaService.pendingRegistration.updateMany({
      where: {
        id,
        otp_hash: otpHash,
      },
      data: {
        attempt_count: { increment: 1 },
      },
    });
  }

  async createPendingRegistration(data: {
    name: string;
    email: string;
    passwordHash: string;
    otpHash: string;
    expiresAt: Date;
  }) {
    return this.prismaService.pendingRegistration.create({
      data: {
        name: data.name,
        email: data.email,
        password_hash: data.passwordHash,
        otp_hash: data.otpHash,
        expires_at: data.expiresAt,
      },
    });
  }

  async updatePendingOtp(email: string, otpHash: string, expiresAt: Date) {
    return this.prismaService.pendingRegistration.update({
      where: { email },
      data: {
        otp_hash: otpHash,
        expires_at: expiresAt,
        attempt_count: 0,
      },
    });
  }

  async updateOtpSendMetadata(
    id: string,
    otpHash: string,
    lastSentAt: Date,
    sendCount: number,
    windowStart: Date,
  ) {
    return this.prismaService.pendingRegistration.updateMany({
      where: {
        id,
        otp_hash: otpHash,
      },
      data: {
        last_sent_at: lastSentAt,
        send_count: sendCount,
        window_start: windowStart,
      },
    });
  }

  async rollbackOtp(
    pendingId: string,
    otpHash: string,
    previousPending: {
      name: string | null;
      password_hash: string;
      otp_hash: string;
      expires_at: Date;
      attempt_count: number;
    } | null,
  ) {
    if (!previousPending) {
      return this.prismaService.pendingRegistration.deleteMany({
        where: {
          id: pendingId,
          otp_hash: otpHash,
        },
      });
    }

    return this.prismaService.pendingRegistration.updateMany({
      where: {
        id: pendingId,
        otp_hash: otpHash,
      },
      data: {
        name: previousPending.name,
        password_hash: previousPending.password_hash,
        otp_hash: previousPending.otp_hash,
        expires_at: previousPending.expires_at,
        attempt_count: previousPending.attempt_count,
      },
    });
  }

  async createVerifiedUser(
    pending: {
      id: string;
      name: string | null;
      email: string;
      password_hash: string;
      otp_hash: string;
    },
    maxAttempts: number,
  ) {
    return this.prismaService.$transaction(async (tx) => {
      const claimed = await tx.pendingRegistration.deleteMany({
        where: {
          id: pending.id,
          otp_hash: pending.otp_hash,
          expires_at: { gt: new Date() },
          attempt_count: { lt: maxAttempts },
        },
      });

      if (claimed.count !== 1) {
        throw new BadRequestException('OTP is no longer valid');
      }

      return tx.user.create({
        data: {
          name: pending.name,
          email: pending.email,
          password: pending.password_hash,
          email_verified_at: new Date(),
        },
      });
    });
  }

}
