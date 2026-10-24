import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	ParseIntPipe,
	Patch,
	Post,
	Req,
	UseGuards,
	HttpCode,
	Header
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AudioStoriesService } from './audio-stories.service.js';
import { CreateAudioStoryDto } from './dto/create-audio-story.dto.js';
import { UpdateAudioStoryDto } from './dto/update-audio-story.dto.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';
import { UpdateStoryCastDto } from './dto/update-story-cast.dto.js';
@Controller('audio-stories')
@UseGuards(AuthGuard)
export class AudioStoriesController {
	constructor(private readonly audioStoriesService: AudioStoriesService) {}

	@Post()
	create(@Body() dto: CreateAudioStoryDto, @Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.create(req.user.id, dto);
	}

	@Get()
	findAll(@Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.findAll(req.user.id);
	}

	@Get(':id')
	findOne(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.findOne(id, req.user.id);
	}

	@Patch(':id')
	update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAudioStoryDto, @Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.update(id, req.user.id, dto);
	}

	@Delete(':id')
	remove(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.remove(id, req.user.id);
	}

	@Post(':id/analyze')
	@HttpCode(202)
	analyze(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.analyze(id, req.user.id);
	}

	@Get(':id/analysis-jobs/latest')
	latestAnalysis(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.getLatestAnalysisJob(id, req.user.id);
	}

	@Get(':id/analysis-jobs/:jobId/wait')
	@Header('Cache-Control', 'private, no-store')
	waitForAnalysis(
		@Param('id', ParseIntPipe) id: number,
		@Param('jobId') jobId: string,
		@Req() req: AuthenticatedRequest
	) {
		return this.audioStoriesService.waitForAnalysis(id, req.user.id, jobId);
	}

	@Post(':id/analysis-jobs/:jobId/cancel')
	cancelAnalysis(
		@Param('id', ParseIntPipe) id: number,
		@Param('jobId') jobId: string,
		@Req() req: AuthenticatedRequest
	) {
		return this.audioStoriesService.cancelAnalysis(id, req.user.id, jobId);
	}

	@Patch(':id/cast')
	updateCast(
		@Param('id', ParseIntPipe) id: number,
		@Body() dto: UpdateStoryCastDto,
		@Req() req: AuthenticatedRequest
	) {
		return this.audioStoriesService.updateCast(id, req.user.id, dto);
	}

	@Get(':id/cast')
	getCast(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.audioStoriesService.getCast(id, req.user.id);
	}
}
