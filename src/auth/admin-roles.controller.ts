import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './auth.guard.js';
import { SuperAdminGuard } from './services/superadmin.guard.js';
import { AuthOriginGuard } from './services/auth-origin.guard.js';
import { AdminRoleService } from './services/admin-role.service.js';
import { AdminPageQuery, AdminUsersQuery, ChangeAdminRoleDto } from './dto/admin-role.dto.js';
import type { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface.js';

@Controller('auth/admin')
@UseGuards(AuthOriginGuard, AdminAuthGuard, SuperAdminGuard)
export class AdminRolesController {
	constructor(private readonly roles: AdminRoleService) {}
	@Get('users') listUsers(@Query() query: AdminUsersQuery) {
		return this.roles.listUsers(query);
	}
	@Patch('users/:userId/role') changeRole(
		@Param('userId', ParseIntPipe) userId: number,
		@Body() dto: ChangeAdminRoleDto,
		@Req() req: AuthenticatedRequest
	) {
		return this.roles.changeRole(req.user.id, req.user.sessionId, userId, dto);
	}
	@Get('role-audit') listAudit(@Query() query: AdminPageQuery) {
		return this.roles.listAudit(query);
	}
}
