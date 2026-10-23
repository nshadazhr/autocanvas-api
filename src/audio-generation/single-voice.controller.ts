import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';

import type { Response } from 'express';

import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';
import { SingleVoiceService } from './single-voice.service.js';

class CreateSingleVoiceDto {
	@IsString()
	@IsNotEmpty()
	@MaxLength(120)
	title!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(12000)
	content!: string;
}

class GenerateSingleVoiceDto {
	@IsInt()
	@Min(1)
	voiceId!: number;

	@IsOptional()
	@IsString()
	@MaxLength(50)
	style?: string;

	@IsOptional()
	@IsString()
	@MaxLength(120)
	title?: string;

	@IsOptional()
	@IsString()
	@MaxLength(12000)
	content?: string;
}

@Controller('audio-generation/single')
@UseGuards(AuthGuard)
export class SingleVoiceController {
	constructor(private readonly single: SingleVoiceService) {}

	@Post('stories')
	create(@Body() dto: CreateSingleVoiceDto, @Req() req: AuthenticatedRequest) {
		return this.single.create(req.user.id, dto.title, dto.content);
	}

	@Get('stories/:storyId')
	get(@Param('storyId', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.single.get(id, req.user.id);
	}

	@Post('stories/:storyId/cancel')
	cancel(@Param('storyId', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.single.cancel(id, req.user.id);
	}

	@Post('stories/:storyId/generate')
	generate(
		@Param('storyId', ParseIntPipe) id: number,
		@Body() dto: GenerateSingleVoiceDto,
		@Req() req: AuthenticatedRequest
	) {
		return this.single.generate(id, req.user.id, dto.voiceId, dto.style, {
			title: dto.title,
			content: dto.content
		});
	}

	@Get('stories/:storyId/audio/:audioId')
	async audio(
		@Param('storyId', ParseIntPipe) storyId: number,
		@Param('audioId', ParseIntPipe) audioId: number,
		@Req() req: AuthenticatedRequest,
		@Res({ passthrough: true }) res: Response
	) {
		const file = await this.single.file(storyId, audioId, req.user.id);

		res.setHeader('Content-Type', file.contentType);
		res.setHeader('Content-Length', file.size);
		res.setHeader('Cache-Control', 'private, no-store');

		return new StreamableFile(file.stream);
	}
}
