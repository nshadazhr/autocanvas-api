import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VoicesController } from './voices.controller.js';
import { VoicesService } from './voices.service.js';

@Module({
	imports: [],
	controllers: [VoicesController],
	providers: [VoicesService, PrismaService]
})
export class VoicesModule {}
