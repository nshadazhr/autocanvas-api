import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsStrongPassword,
  Matches,
} from 'class-validator';

export class RegisterDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsStrongPassword()
  password: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

export class VerifyOtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'OTP must be a 6-digit number',
  })
  otp: string;
}
export class ResendOtpDto {
  @IsEmail()
  email: string;
}
