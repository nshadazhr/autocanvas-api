import { Body, Controller, Get, Header, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { CreditsService, type CreditKind } from './credits.service.js';
export class CreditQuoteDto {
	@IsIn(['ANALYSIS', 'AUDIO', 'SINGLE_AUDIO']) kind!: CreditKind;
	@IsInt() @Min(1) storyId!: number;
	@IsOptional() @IsInt() @Min(1) sceneId?: number;
	@IsOptional() @IsInt() @Min(1) jobId?: number;
	@IsOptional() @IsString() @MaxLength(12000) content?: string;
}
@Controller('credits')
@UseGuards(AuthGuard, AuthOriginGuard)
export class CreditsController {
	constructor(private readonly credits: CreditsService) {}
	@Get('wallet') @Header('Cache-Control', 'private, no-store') wallet(@Req() req: { user: { id: number } }) {
		return this.credits.wallet(req.user.id);
	}
	@Get('history') @Header('Cache-Control', 'private, no-store') history(
		@Req() req: { user: { id: number } },
		@Query('cursor') cursor?: string
	) {
		return this.credits.history(req.user.id, cursor);
	}
	@Post('quote') @Header('Cache-Control', 'private, no-store') quote(
		@Req() req: { user: { id: number } },
		@Body() dto: CreditQuoteDto
	) {
		return this.credits.quote(req.user.id, dto);
	}
}
