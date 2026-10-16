import { Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { audioGenerationService } from './audio-generation.service.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';
import { Res, Headers, HttpStatus, StreamableFile, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { AuthGuard } from '../auth/auth.guard.js';

@Controller('audio-generation')
@UseGuards(AuthGuard)
export class AudioGenerationController {
	constructor(private readonly audioGenerationService: audioGenerationService) {}

	@Post('stories/:storyId/jobs')
	async createJob(@Param('storyId', ParseIntPipe) storyId: number, @Req() req: AuthenticatedRequest) {
		const job = await this.audioGenerationService.createGenerationJob(storyId, req.user.id);

		this.audioGenerationService.startGenerationInBackground(job.id);

		return job;
	}

	@Get('jobs/:jobId')
	getJob(@Param('jobId', ParseIntPipe) jobId: number, @Req() req: AuthenticatedRequest) {
		return this.audioGenerationService.getGenerationJob(jobId, req.user.id);
	}

	@Post('jobs/:jobId/retry')
	async retryJob(@Param('jobId', ParseIntPipe) jobId: number, @Req() req: AuthenticatedRequest) {
		const job = await this.audioGenerationService.retryFailedJob(jobId, req.user.id);

		this.audioGenerationService.startGenerationInBackground(job.id);

		return job;
	}

	@Get('audio/:audioId/stream')
	async streamAudio(
		@Param('audioId', ParseIntPipe) audioId: number,
		@Req() req: AuthenticatedRequest,
		@Res({ passthrough: true }) res: Response,
		@Headers('range') range?: string
	) {
		const audio = await this.audioGenerationService.getAudioFile(audioId, req.user.id);

		const { absolutePath, fileSize, mimeType } = audio;

		res.setHeader('Content-Type', mimeType);
		res.setHeader('Accept-Ranges', 'bytes');
		res.setHeader('Cache-Control', 'private, no-store');

		if (!range) {
			res.setHeader('Content-Length', fileSize);
			return new StreamableFile(createReadStream(absolutePath));
		}

		const match = /^bytes=(\d*)-(\d*)$/.exec(range);

		if (!match || (!match[1] && !match[2])) {
			throw new BadRequestException('Invalid range');
		}

		let start: number;
		let end: number;

		if (!match[1]) {
			const suffix = Number(match[2]);
			start = Math.max(0, fileSize - suffix);
			end = fileSize - 1;
		} else {
			start = Number(match[1]);
			end = match[2] ? Number(match[2]) : fileSize - 1;
		}

		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			start >= fileSize ||
			end < start
		) {
			res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
			res.setHeader('Content-Range', `bytes */${fileSize}`);
			return;
		}

		end = Math.min(end, fileSize - 1);

		res.status(HttpStatus.PARTIAL_CONTENT);
		res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
		res.setHeader('Content-Length', end - start + 1);

		return new StreamableFile(createReadStream(absolutePath, { start, end }));
	}

	@Get('exports/:assetId/download')
	async downloadExportedWav(
		@Param('assetId', ParseIntPipe) assetId: number,
		@Req() req: AuthenticatedRequest,
		@Res({ passthrough: true }) res: Response
	): Promise<StreamableFile> {
		const file = await this.audioGenerationService.getExportedAudioFile(assetId, req.user.id);

		res.setHeader('Content-Type', file.mimeType);
		res.setHeader('Content-Length', file.fileSize);
		res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
		res.setHeader('Cache-Control', 'private, no-store');

		return new StreamableFile(createReadStream(file.absolutePath));
	}

	@Get('stories/:storyId/audio-history')
	getStoryAudioHistory(@Param('storyId', ParseIntPipe) storyId: number, @Req() req: AuthenticatedRequest) {
		return this.audioGenerationService.getStoryAudioHistory(storyId, req.user.id);
	}

	@Post('stories/:storyId/export-wav')
	async exportStoryWav(@Param('storyId', ParseIntPipe) storyId: number, @Req() req: AuthenticatedRequest) {
		return this.audioGenerationService.exportStoryWav(storyId, req.user.id);
	}

	@Get('stories/:storyId/download-zip')
	async downloadStoryAudioZip(
		@Param('storyId', ParseIntPipe) storyId: number,
		@Req() req: AuthenticatedRequest,
		@Res({ passthrough: true }) res: Response
	): Promise<StreamableFile> {
		const { stream, filename } = await this.audioGenerationService.downloadStoryAudioZip(storyId, req.user.id);

		res.setHeader('Content-Type', 'application/zip');
		res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		res.setHeader('Cache-Control', 'private, no-store');

		return new StreamableFile(stream);
	}

	@Post('stories/:storyId/scenes/:sceneId/regenerate')
	async regenerateScene(
		@Param('storyId', ParseIntPipe) storyId: number,
		@Param('sceneId', ParseIntPipe) sceneId: number,
		@Req() req: AuthenticatedRequest
	) {
		const job = await this.audioGenerationService.createSingleSceneJob(storyId, sceneId, req.user.id);

		this.audioGenerationService.startGenerationInBackground(job.id);

		return job;
	}
}
