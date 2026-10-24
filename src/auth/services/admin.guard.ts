import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class AdminGuard implements CanActivate {
	constructor(private readonly prisma: PrismaService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();

		// AuthGuard has already verified the JWT
		const userId = request.user?.id;

		if (!Number.isSafeInteger(userId) || userId <= 0 || request.user?.realm !== 'admin') {
			throw new UnauthorizedException('Unauthorized');
		}

		// Fetch the current user role from database
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: {
				id: true,
				role: true,
				name: true,
				email: true
			}
		});

		if (!user) {
			throw new UnauthorizedException('User not found');
		}

		// Only ADMIN and SUPERADMIN are allowed
		if (user.role !== 'ADMIN' && user.role !== 'SUPERADMIN') {
			throw new ForbiddenException('Admin access required');
		}

		request.adminUser = user;

		return true;
	}
}
