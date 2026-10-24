import { defineConfig } from 'vitest/config';
export default defineConfig({
	cacheDir: '/private/tmp/autocanvas-admin-auth-vitest-cache',
	test: {
		globals: true,
		include: ['src/auth/admin-auth.integration.spec.ts', 'src/auth/superadmin.integration.spec.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
		fileParallelism: false
	}
});
