import 'reflect-metadata';
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { AdminRoleService } from '../auth/services/admin-role.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === '--help') {
		console.log('Usage: npm run admin:bootstrap -- --email registered@example.com');
		return;
	}
	if (args.length !== 2 || args[0] !== '--email' || !args[1]) {
		console.error('Usage: npm run admin:bootstrap -- --email registered@example.com');
		process.exitCode = 1;
		return;
	}
	if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured');
	const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
	try {
		const result = await new AdminRoleService(prisma as PrismaService).bootstrap(args[1]);
		console.log(
			result.changed
				? `Superadmin created for user ${result.user.id}. Sign in again through admin login.`
				: `User ${result.user.id} is already a superadmin. No changes made.`
		);
	} finally {
		await prisma.$disconnect();
	}
}
main().catch(error => {
	// Do not print Prisma connection errors, credentials or account records.
	const safe =
		error?.getStatus?.() && error instanceof Error
			? error.message
			: 'Superadmin setup failed. Check the command arguments, database configuration and backend migration status.';
	console.error(safe);
	process.exitCode = 1;
});
