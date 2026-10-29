import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	Param,
	ParseIntPipe,
	Patch,
	Post,
	Query,
	Req,
	UseGuards
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { SuperAdminGuard } from '../auth/services/superadmin.guard.js';
import { AuthOriginGuard } from '../auth/services/auth-origin.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreditsService } from '../credits/credits.service.js';
export class AdjustmentDto {
	@IsInt() @Min(-1000000) @Max(1000000) amount!: number;
	@IsString() @Length(3, 300) reason!: string;
	@IsUUID() requestId!: string;
	@IsOptional() @IsBoolean() unblock?: boolean;
}
export class PackDto {
	@IsString() @Length(1, 80) name!: string;
	@IsInt() @Min(1) @Max(1000000) credits!: number;
	@IsInt() @Min(100) @Max(100000000) amountPaise!: number;
	@IsBoolean() active!: boolean;
}
@Controller('admin/credits')
@UseGuards(AuthOriginGuard, AdminAuthGuard, SuperAdminGuard)
export class AdminCreditsController {
	constructor(
		private readonly prisma: PrismaService,
		private readonly credits: CreditsService
	) {}
	@Get('users') @Header('Cache-Control', 'private, no-store') users(@Query('search') search = '') {
		return this.prisma.user.findMany({
			where: {
				OR: [
					{ email: { contains: search.slice(0, 100), mode: 'insensitive' } },
					{ name: { contains: search.slice(0, 100), mode: 'insensitive' } }
				]
			},
			take: 20,
			orderBy: { id: 'desc' },
			select: { id: true, name: true, email: true, creditBalance: true, creditsBlocked: true }
		});
	}
	@Get('users/:id') @Header('Cache-Control', 'private, no-store') wallet(@Param('id', ParseIntPipe) id: number) {
		return this.credits.wallet(id);
	}
	@Post('users/:id/adjust') async adjust(
		@Param('id', ParseIntPipe) id: number,
		@Req() req: { user: { id: number } },
		@Body() dto: AdjustmentDto
	) {
		if ((!dto.amount && !dto.unblock) || dto.reason.trim().length < 3)
			throw new BadRequestException('Enter an adjustment and a reason');
		await this.prisma.$transaction(async tx => {
			const reference = `admin:${req.user.id}:${dto.requestId}`;
			const { created } = await this.credits.grant(
				tx,
				id,
				dto.amount,
				reference,
				'ADMIN',
				dto.reason.trim() + (dto.unblock ? ' [payment review cleared]' : ''),
				req.user.id
			);
			if (dto.unblock && created) {
				await tx.creditPurchase.updateMany({
					where: { userId: id, status: 'REVIEW' },
					data: { status: 'REVIEWED' }
				});
				await tx.user.update({ where: { id }, data: { creditsBlocked: false } });
			}
		});
		return this.credits.wallet(id);
	}
	@Get('packs') @Header('Cache-Control', 'private, no-store') packs() {
		return this.prisma.creditPack.findMany({ orderBy: { createdAt: 'asc' } });
	}
	@Post('packs') create(@Body() dto: PackDto) {
		if (!dto.name.trim()) throw new BadRequestException('Pack name is required');
		return this.prisma.creditPack.create({ data: { ...dto, name: dto.name.trim() } });
	}
	@Patch('packs/:id') update(@Param('id') id: string, @Body() dto: PackDto) {
		if (!dto.name.trim()) throw new BadRequestException('Pack name is required');
		return this.prisma.creditPack.update({ where: { id }, data: { ...dto, name: dto.name.trim() } });
	}
}
