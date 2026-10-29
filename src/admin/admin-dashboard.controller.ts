import {
	Controller,
	DefaultValuePipe,
	Get,
	Header,
	ParseIntPipe,
	Query,
	Req,
	UseGuards
} from '@nestjs/common';
import { AdminAuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/services/admin.guard.js';
import { AdminDashboardService } from './admin-dashboard.service.js';

@Controller('admin/dashboard')
@UseGuards(AdminAuthGuard, AdminGuard)
export class AdminDashboardController {
	constructor(private readonly dashboard: AdminDashboardService) {}
	@Get()
	@Header('Cache-Control', 'private, no-store')
	overview(
		@Query('days', new DefaultValuePipe(30), new ParseIntPipe()) days: number,
		@Req() req: { adminUser: { role: string } }
	) {
		return this.dashboard.overview(days, req.adminUser.role === 'SUPERADMIN');
	}
}
