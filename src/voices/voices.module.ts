import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiModule } from '../ai/ai.module.js';
import { VoicesController } from './voices.controller.js';
import { VoicesService } from './voices.service.js';

@Module({
	imports: [AiModule],
	controllers: [VoicesController],
	providers: [VoicesService, PrismaService]
})
export class VoicesModule {}
