import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Module({
	controllers: [ProjectsController],
	providers: [ProjectsService, PrismaService]
})
export class ProjectsModule {}
