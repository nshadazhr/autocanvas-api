import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AdminGuard } from './admin.guard.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class SuperAdminGuard extends AdminGuard {
	constructor(prisma: PrismaService) {
		super(prisma);
	}
	async canActivate(context: ExecutionContext): Promise<boolean> {
		await super.canActivate(context);
		if (context.switchToHttp().getRequest().adminUser.role !== 'SUPERADMIN')
			throw new ForbiddenException('Superadmin access required');
		return true;
	}
}
