import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginDto, RegisterDto } from './dto/register.dto.js';
import { UserService } from '../user/user.service.js';
import { PasswordHasher } from '@nestjs/authentication';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly passwordHasher: PasswordHasher,
    private readonly jwtService: JwtService,
  ) {}

  async getUniqueEmail(email: string) {
    const uniqueEmail = await this.userService.getUniqueEmail(email);
    return uniqueEmail;
  }

  async register(registerDto: RegisterDto) {
    let filteredUniqueEmail = await this.getUniqueEmail(registerDto.email);

    if (filteredUniqueEmail) {
      throw new ConflictException(
        `${filteredUniqueEmail?.email} Email Already Exist`,
      );
    } else {
      const hashPassword = await this.passwordHasher.hash(registerDto.password);
      const createdUserData = await this.userService.createUserData({
        ...registerDto,
        password: hashPassword,
      });
      const payload = { id: createdUserData.id, email: createdUserData.email };
      let access_token = await this.jwtService.signAsync(payload);
      const { password, ...safeUser } = createdUserData;
      return { ...safeUser, access_token };
    }
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

    const access_token = await this.jwtService.signAsync(payload);

    const { password, ...safeUser } = filteredUniqueEmail;

    return { ...safeUser, access_token };
  }
}
