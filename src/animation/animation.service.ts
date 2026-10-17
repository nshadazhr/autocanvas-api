import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAnimationProjectDto } from './dto/create-animation-project.dto.js';
import { UpdateAnimationProjectDto } from './dto/update-animation-project.dto.js';
import { CreateAnimationSceneDto } from './dto/create-animation-scene.dto.js';
import { UpdateAnimationSceneDto } from './dto/update-animation-scene.dto.js';

@Injectable()
export class AnimationService {
	constructor(private readonly prisma: PrismaService) {}

	getHealth() {
		return {
			success: true,
			message: 'Animation API is working'
		};
	}

	async createProject(userId: number, dto: CreateAnimationProjectDto) {
		const validResolutions = [
			[1280, 720],
			[1920, 1080],
			[3840, 2160]
		];

		const isValidResolution = validResolutions.some(
			([width, height]) => width === dto.width && height === dto.height
		);

		if (!isValidResolution) {
			throw new BadRequestException('Invalid resolution');
		}

		return this.prisma.animationProject.create({
			data: {
				userId,
				name: dto.name.trim(),
				width: dto.width,
				height: dto.height,
				fps: dto.fps
			}
		});
	}

	async getProjects(userId: number) {
		return this.prisma.animationProject.findMany({
			where: {
				userId
			},
			orderBy: {
				createdAt: 'desc'
			}
		});
	}

	async getProjectById(userId: number, projectId: number) {
		const project = await this.prisma.animationProject.findFirst({
			where: {
				id: projectId,
				userId
			},
			include: {
				scenes: {
					orderBy: {
						sortOrder: 'asc'
					}
				}
			}
		});

		if (!project) {
			throw new NotFoundException('Animation project not found');
		}

		return project;
	}

	async updateProject(userId: number, projectId: number, dto: UpdateAnimationProjectDto) {
		const project = await this.getProjectById(userId, projectId);

		const width = dto.width ?? project.width;
		const height = dto.height ?? project.height;

		const validResolutions = [
			[1280, 720],
			[1920, 1080],
			[3840, 2160]
		];

		const isValidResolution = validResolutions.some(([w, h]) => w === width && h === height);

		if (!isValidResolution) {
			throw new BadRequestException('Invalid resolution');
		}

		if (dto.name !== undefined && !dto.name.trim()) {
			throw new BadRequestException('Project name is required');
		}

		return this.prisma.animationProject.update({
			where: {
				id: projectId,
				userId
			},
			data: {
				...(dto.name !== undefined && { name: dto.name.trim() }),
				...(dto.width !== undefined && { width: dto.width }),
				...(dto.height !== undefined && { height: dto.height }),
				...(dto.fps !== undefined && { fps: dto.fps })
			}
		});
	}

	async deleteProject(userId: number, projectId: number) {
		await this.getProjectById(userId, projectId);

		await this.prisma.animationProject.delete({
			where: {
				id: projectId,
				userId
			}
		});

		return {
			success: true,
			message: 'Animation project deleted successfully'
		};
	}

	// CREATE SCENE
	async createScene(userId: number, projectId: number, dto: CreateAnimationSceneDto) {
		await this.getProjectById(userId, projectId);

		return this.prisma.animationScene.create({
			data: {
				projectId,
				name: dto.name.trim(),
				...(dto.sortOrder !== undefined && {
					sortOrder: dto.sortOrder
				}),
				...(dto.durationMs !== undefined && {
					durationMs: dto.durationMs
				})
			}
		});
	}

	// GET ALL SCENES
	async getScenes(userId: number, projectId: number) {
		await this.getProjectById(userId, projectId);

		return this.prisma.animationScene.findMany({
			where: { projectId },
			orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }]
		});
	}

	// GET SINGLE SCENE
	async getSceneById(userId: number, projectId: number, sceneId: number) {
		const scene = await this.prisma.animationScene.findFirst({
			where: {
				id: sceneId,
				projectId,
				project: {
					userId
				}
			}
		});

		if (!scene) {
			throw new NotFoundException('Animation scene not found');
		}

		return scene;
	}

	// UPDATE SCENE
	async updateScene(userId: number, projectId: number, sceneId: number, dto: UpdateAnimationSceneDto) {
		await this.getSceneById(userId, projectId, sceneId);

		if (dto.name !== undefined && !dto.name.trim()) {
			throw new BadRequestException('Scene name is required');
		}

		return this.prisma.animationScene.update({
			where: { id: sceneId },
			data: {
				...(dto.name !== undefined && {
					name: dto.name.trim()
				}),
				...(dto.sortOrder !== undefined && {
					sortOrder: dto.sortOrder
				}),
				...(dto.durationMs !== undefined && {
					durationMs: dto.durationMs
				})
			}
		});
	}

	// DELETE SCENE
	async deleteScene(userId: number, projectId: number, sceneId: number) {
		await this.getSceneById(userId, projectId, sceneId);

		await this.prisma.animationScene.delete({
			where: { id: sceneId }
		});

		return {
			success: true,
			message: 'Animation scene deleted successfully'
		};
	}
}
