import { IsEmail, MaxLength, IsNotEmpty, IsString, IsStrongPassword, Matches } from 'class-validator';

export class RegisterDto {
	@IsNotEmpty()
	@IsString()
	name: string;

	@MaxLength(254)
	@IsEmail()
	email: string;

	@IsStrongPassword()
	password: string;
}

export class LoginDto {
	@MaxLength(254)
	@IsEmail()
	email: string;

	@IsNotEmpty()
	@MaxLength(1024)
	@IsString()
	password: string;
}

export class VerifyOtpDto {
	@MaxLength(254)
	@IsEmail()
	email: string;

	@IsString()
	@Matches(/^\d{6}$/, {
		message: 'OTP must be a 6-digit number'
	})
	otp: string;
}
export class ResendOtpDto {
	@MaxLength(254)
	@IsEmail()
	email: string;
}
