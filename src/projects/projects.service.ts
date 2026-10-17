import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';

@Injectable()
export class ProjectsService {
	constructor(private readonly prisma: PrismaService) {}

	async create(userId: number, dto: CreateProjectDto) {
		return this.prisma.project.create({
			data: {
				name: dto.name,
				description: dto.description,
				userId
			}
		});
	}

	async findAll(userId: number) {
		return this.prisma.project.findMany({
			where: {
				userId
			},
			orderBy: {
				created_at: 'desc'
			}
		});
	}

	async findOne(id: number, userId: number) {
		const project = await this.prisma.project.findFirst({
			where: {
				id,
				userId
			}
		});

		if (!project) {
			throw new NotFoundException('Project not found');
		}

		return project;
	}

	async update(id: number, userId: number, dto: UpdateProjectDto) {
		await this.findOne(id, userId);

		return this.prisma.project.update({
			where: { id, userId },
			data: {
				name: dto.name,
				description: dto.description
			}
		});
	}

	async remove(id: number, userId: number) {
		await this.findOne(id, userId);

		return this.prisma.project.delete({
			where: {
				id,
				userId
			}
		});
	}
}
