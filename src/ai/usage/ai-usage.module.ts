import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiUsageService } from './ai-usage.service.js';

@Module({ imports: [ConfigModule], providers: [PrismaService, AiUsageService], exports: [AiUsageService] })
export class AiUsageModule {}
