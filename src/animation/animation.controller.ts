import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Request, UseGuards } from '@nestjs/common';

import { AnimationService } from './animation.service.js';
import { CreateAnimationProjectDto } from './dto/create-animation-project.dto.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { UpdateAnimationProjectDto } from './dto/update-animation-project.dto.js';
import { UpdateAnimationSceneDto } from './dto/update-animation-scene.dto.js';
import { CreateAnimationSceneDto } from './dto/create-animation-scene.dto.js';

@Controller('animation')
@UseGuards(AuthGuard)
export class AnimationController {
	constructor(private readonly animationService: AnimationService) {}

	@Get('health')
	getHealth() {
		return this.animationService.getHealth();
	}

	@Post('projects')
	createProject(@Body() dto: CreateAnimationProjectDto, @Request() req: { user: { id: number; email: string } }) {
		return this.animationService.createProject(req.user.id, dto);
	}

	@Get('projects')
	getProjects(@Request() req: { user: { id: number; email: string } }) {
		return this.animationService.getProjects(req.user.id);
	}

	@UseGuards(AuthGuard)
	@Get('projects/:id')
	getProjectById(
		@Param('id', ParseIntPipe) projectId: number,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.getProjectById(req.user.id, projectId);
	}

	@Patch('projects/:id')
	updateProject(
		@Param('id', ParseIntPipe) projectId: number,
		@Body() dto: UpdateAnimationProjectDto,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.updateProject(req.user.id, projectId, dto);
	}

	@Delete('projects/:id')
	deleteProject(
		@Param('id', ParseIntPipe) projectId: number,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.deleteProject(req.user.id, projectId);
	}

	// CREATE SCENE
	@UseGuards(AuthGuard)
	@Post('projects/:projectId/scenes')
	createScene(
		@Param('projectId', ParseIntPipe) projectId: number,
		@Body() dto: CreateAnimationSceneDto,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.createScene(req.user.id, projectId, dto);
	}

	// GET ALL SCENES
	@UseGuards(AuthGuard)
	@Get('projects/:projectId/scenes')
	getScenes(
		@Param('projectId', ParseIntPipe) projectId: number,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.getScenes(req.user.id, projectId);
	}

	// GET SINGLE SCENE
	@UseGuards(AuthGuard)
	@Get('projects/:projectId/scenes/:sceneId')
	getSceneById(
		@Param('projectId', ParseIntPipe) projectId: number,
		@Param('sceneId', ParseIntPipe) sceneId: number,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.getSceneById(req.user.id, projectId, sceneId);
	}

	// UPDATE SCENE
	@Patch('projects/:projectId/scenes/:sceneId')
	updateScene(
		@Param('projectId', ParseIntPipe) projectId: number,
		@Param('sceneId', ParseIntPipe) sceneId: number,
		@Body() dto: UpdateAnimationSceneDto,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.updateScene(req.user.id, projectId, sceneId, dto);
	}

	// DELETE SCENE
	@Delete('projects/:projectId/scenes/:sceneId')
	deleteScene(
		@Param('projectId', ParseIntPipe) projectId: number,
		@Param('sceneId', ParseIntPipe) sceneId: number,
		@Request() req: { user: { id: number; email: string } }
	) {
		return this.animationService.deleteScene(req.user.id, projectId, sceneId);
	}
}
