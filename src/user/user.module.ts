import { Module } from '@nestjs/common';
import { UserService } from './user.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Module({
  providers: [UserService, PrismaService],
  exports: [UserService],
})
export class UserModule {}
