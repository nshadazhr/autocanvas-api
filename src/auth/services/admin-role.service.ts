import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	UnauthorizedException
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UserRole, type Prisma } from '../../generated/prisma/client.js';
import { AdminPageQuery, AdminUsersQuery, ChangeAdminRoleDto } from '../dto/admin-role.dto.js';
const safeUser = { id: true, name: true, email: true, role: true, email_verified_at: true } as const;

@Injectable()
export class AdminRoleService {
	constructor(private readonly prisma: PrismaService) {}
	async listUsers(query: AdminUsersQuery) {
		const search = query.search?.trim();
		const values = await this.prisma.user.findMany({
			where: {
				...(query.cursor ? { id: { gt: query.cursor } } : {}),
				...(query.role ? { role: query.role } : {}),
				...(search
					? {
							OR: [
								{ email: { contains: search, mode: 'insensitive' as const } },
								{ name: { contains: search, mode: 'insensitive' as const } }
							]
						}
					: {})
			},
			select: safeUser,
			orderBy: { id: 'asc' },
			take: query.limit + 1
		});
		return {
			users: values.slice(0, query.limit),
			nextCursor: values.length > query.limit ? values[query.limit - 1].id : null
		};
	}
	async listAudit(query: AdminPageQuery) {
		const values = await this.prisma.adminRoleAudit.findMany({
			where: query.cursor ? { id: { gt: query.cursor } } : {},
			orderBy: { id: 'asc' },
			take: query.limit + 1
		});
		return {
			events: values.slice(0, query.limit),
			nextCursor: values.length > query.limit ? values[query.limit - 1].id : null
		};
	}
	// All application role writers, including the server-only bootstrap command,
	// share this lock. Rechecking the actor inside it prevents concurrent demotion races.
	private withRoleLock<T>(action: (tx: Prisma.TransactionClient) => Promise<T>) {
		return this.prisma.$transaction(
			async tx => {
				await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(73129,0)`;
				return action(tx);
			},
			{ maxWait: 10000, timeout: 15000 }
		);
	}
	async changeRole(actorId: number, sessionId: string | undefined, targetId: number, dto: ChangeAdminRoleDto) {
		if (!sessionId) throw new UnauthorizedException();
		const reason = dto.reason.trim();
		if (reason.length < 5 || reason.length > 500 || !Object.values(UserRole).includes(dto.role))
			throw new BadRequestException('A valid role and a reason of 5–500 characters are required');
		return this.withRoleLock(async tx => {
			const actor = await tx.user.findUnique({ where: { id: actorId }, select: safeUser });
			if (actor?.role !== 'SUPERADMIN') throw new ForbiddenException('Superadmin access required');
			if (
				!(await tx.authSession.findFirst({
					where: {
						id: sessionId,
						userId: actorId,
						realm: 'admin',
						revokedAt: null,
						expiresAt: { gt: new Date() }
					},
					select: { id: true }
				}))
			)
				throw new UnauthorizedException('Session expired');
			const target = await tx.user.findUnique({
				where: { id: targetId },
				select: { ...safeUser, password: true }
			});
			if (!target) throw new NotFoundException('User not found');
			if (target.role === dto.role) {
				const { password, ...user } = target;
				return { user, changed: false };
			}
			if (
				target.role === 'SUPERADMIN' &&
				dto.role !== 'SUPERADMIN' &&
				(await tx.user.count({ where: { role: 'SUPERADMIN' } })) <= 1
			)
				throw new ConflictException('The last superadmin cannot be demoted');
			if (dto.role !== 'USER' && (!target.password || !target.email_verified_at))
				throw new BadRequestException('Admin accounts must have a verified email and password login enabled');
			const user = await tx.user.update({ where: { id: targetId }, data: { role: dto.role }, select: safeUser });
			await tx.authSession.updateMany({
				where: { userId: targetId, revokedAt: null },
				data: { revokedAt: new Date() }
			});
			await tx.adminRoleAudit.create({
				data: {
					actorId: actor.id,
					actorEmail: actor.email,
					targetId: target.id,
					targetEmail: target.email,
					action: 'ROLE_CHANGED',
					fromRole: target.role,
					toRole: dto.role,
					reason
				}
			});
			return { user, changed: true };
		});
	}
	// Called only by the server command; never exposed as a controller route.
	async bootstrap(email: string) {
		const normalized = email.trim().toLowerCase();
		if (!normalized || normalized.length > 254 || !normalized.includes('@'))
			throw new BadRequestException('Provide the registered account email');
		return this.withRoleLock(async tx => {
			const target = await tx.user.findUnique({
				where: { email: normalized },
				select: { ...safeUser, password: true }
			});
			if (!target) throw new NotFoundException('Register and verify the account before running bootstrap');
			const count = await tx.user.count({ where: { role: 'SUPERADMIN' } });
			if (count > 0) {
				if (target.role === 'SUPERADMIN') {
					const { password, ...user } = target;
					return { user, changed: false };
				}
				throw new ConflictException('A superadmin already exists. Use authenticated role management instead');
			}
			if (!target.password || !target.email_verified_at)
				throw new BadRequestException('Verify the account email and enable password login first');
			const user = await tx.user.update({
				where: { id: target.id },
				data: { role: 'SUPERADMIN' },
				select: safeUser
			});
			await tx.authSession.updateMany({
				where: { userId: target.id, revokedAt: null },
				data: { revokedAt: new Date() }
			});
			await tx.adminRoleAudit.create({
				data: {
					targetId: target.id,
					targetEmail: target.email,
					action: 'SUPERADMIN_BOOTSTRAPPED',
					fromRole: target.role,
					toRole: 'SUPERADMIN',
					reason: 'Initial superadmin setup through the server command'
				}
			});
			return { user, changed: true };
		});
	}
}
