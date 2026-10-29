import { Body, Controller, Get, Header, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, IsUUID, Matches } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { PaymentsService } from './payments.service.js';
export class CreatePurchaseDto {
	@IsUUID() packId!: string;
	@IsUUID() requestId!: string;
}
export class VerifyPurchaseDto {
	@IsString() @Matches(/^pay_[a-zA-Z0-9]+$/) paymentId!: string;
	@IsString() @Matches(/^[a-f0-9]{64}$/i) signature!: string;
}
@Controller('credits/payments')
@UseGuards(AuthGuard, AuthOriginGuard)
export class PaymentsController {
	constructor(private readonly payments: PaymentsService) {}
	@Get('config') @Header('Cache-Control', 'private, no-store') info() {
		return this.payments.info();
	}
	@Post('orders') create(@Req() req: { user: { id: number } }, @Body() dto: CreatePurchaseDto) {
		return this.payments.create(req.user.id, dto.packId, dto.requestId);
	}
	@Post(':id/verify') verify(
		@Req() req: { user: { id: number } },
		@Param('id') id: string,
		@Body() dto: VerifyPurchaseDto
	) {
		return this.payments.verify(req.user.id, id, dto.paymentId, dto.signature);
	}
	@Post(':id/refresh') refresh(@Req() req: { user: { id: number } }, @Param('id') id: string) {
		return this.payments.refresh(req.user.id, id);
	}
}
@Controller('credits/payments/webhook')
export class PaymentWebhookController {
	constructor(private readonly payments: PaymentsService) {}
	@Post() webhook(@Req() req: { rawBody?: Buffer }, @Headers('x-razorpay-signature') signature: string) {
		return this.payments.webhook(req.rawBody, signature ?? '');
	}
}
