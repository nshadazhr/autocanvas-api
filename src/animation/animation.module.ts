import { Module } from '@nestjs/common';
import { AnimationController } from './animation.controller.js';
import { AnimationService } from './animation.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Module({
	imports: [],
	controllers: [AnimationController],
	providers: [AnimationService, AuthGuard, PrismaService],
	exports: []
})
export class AnimationModule {}
