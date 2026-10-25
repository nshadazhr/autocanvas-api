import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreditsService } from './credits.service.js';
import { CreditsController } from './credits.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentsController, PaymentWebhookController } from './payments.controller.js';
@Module({
	controllers: [CreditsController, PaymentsController, PaymentWebhookController],
	providers: [PrismaService, CreditsService, PaymentsService],
	exports: [CreditsService]
})
export class CreditsModule {}
