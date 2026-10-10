import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  constructor(private readonly resend: Resend) {}

  async sendRegistrationOtp(email: string, otp: string) {
    const { data, error } = await this.resend.emails.send({
      from:
        process.env.RESEND_FROM_EMAIL || 'AutoCanvas <onboarding@resend.dev>',
      to: email,
      subject: 'Verify your AutoCanvas account',
      html: `
		  <h2>Welcome to AutoCanvas!</h2>
		  <p>Your email verification code is:</p>
		  <h1>${otp}</h1>
		  <p>This code will expire in 10 minutes.</p>
		  <p>If you did not request this, please ignore this email.</p>
		`,
    });

    if (error) {
      console.error('Resend API Error:', error.message);

      throw new InternalServerErrorException(
        'Unable to send verification email. Please try again',
      );
    }

    if (!data?.id) {
      throw new InternalServerErrorException(
        'Unable to confirm verification email request',
      );
    }

    return data;
  }
}
