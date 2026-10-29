import { defineConfig } from 'vitest/config';
export default defineConfig({
	cacheDir: '/private/tmp/autocanvas-admin-auth-vitest-cache',
	test: {
		globals: true,
		include: [
			'src/ai/ai-diagnostics.spec.ts',
			'src/auth/admin-auth.integration.spec.ts',
			'src/auth/superadmin.integration.spec.ts',
			'src/admin/admin-settings.integration.spec.ts',
			'src/admin/admin-analysis-jobs.spec.ts',
			'src/admin/admin-analysis-performance.integration.spec.ts',
			'src/settings/runtime-clients.spec.ts',
			'src/settings/provider-credentials.spec.ts',
			'src/settings/env-only-credentials-migration.integration.spec.ts'
		],
		testTimeout: 20000,
		hookTimeout: 20000,
		fileParallelism: false
	}
});
