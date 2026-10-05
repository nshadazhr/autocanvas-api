import { Injectable } from '@nestjs/common';
import { RegisterDto } from '../auth/dto/register.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class UserService {
  constructor(private readonly prismaService: PrismaService) {}
 async getUniqueEmail(email: string) {
    const uniqueEmail = await this.prismaService.user.findFirst({where: {email}})
    return uniqueEmail;
  }

  createUserData(registerDto: RegisterDto) {
    const created_data = this.prismaService.user.create({
      data: {
        email: registerDto.email,
        name: registerDto.name,
        password: registerDto.password,
      },
    });
    return created_data;
  }
}
