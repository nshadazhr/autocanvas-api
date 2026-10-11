import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard.js';
import { ProjectsService } from './projects.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';

interface AuthenticatedRequest extends Request {
	user: {
		id: number;
		email: string;
	};
}

@Controller('projects')
@UseGuards(AuthGuard)
export class ProjectsController {
	constructor(private readonly projectsService: ProjectsService) {}

	@Post()
	create(@Body() dto: CreateProjectDto, @Req() req: AuthenticatedRequest) {
		return this.projectsService.create(req.user.id, dto);
	}

	@Get()
	findAll(@Req() req: AuthenticatedRequest) {
		return this.projectsService.findAll(req.user.id);
	}

	@Get(':id')
	findOne(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.projectsService.findOne(id, req.user.id);
	}

	@Patch(':id')
	update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProjectDto, @Req() req: AuthenticatedRequest) {
		return this.projectsService.update(id, req.user.id, dto);
	}

	@Delete(':id')
	remove(@Param('id', ParseIntPipe) id: number, @Req() req: AuthenticatedRequest) {
		return this.projectsService.remove(id, req.user.id);
	}
}
