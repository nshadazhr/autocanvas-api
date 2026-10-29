import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsStrongPassword, Matches, MaxLength } from 'class-validator';

export class ForgotPasswordDto {
	@Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
	@IsEmail()
	@MaxLength(254)
	email: string;
}
export class ResetPasswordDto {
	@IsString()
	@Matches(/^[a-f0-9]{64}$/, { message: 'Invalid reset token' })
	token: string;

	@IsString()
	@MaxLength(1024)
	@IsStrongPassword()
	password: string;
}
