import { defineConfig } from 'vitest/config';
export default defineConfig({
	cacheDir: '/private/tmp/autocanvas-admin-dashboard-vitest-cache',
	test: {
		globals: true,
		include: ['src/admin/admin-dashboard.integration.spec.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
		fileParallelism: false
	}
});
