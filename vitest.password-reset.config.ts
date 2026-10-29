import { defineConfig } from 'vitest/config';
export default defineConfig({
	cacheDir: '/private/tmp/autocanvas-password-reset-vitest-cache',
	test: {
		globals: true,
		include: ['src/auth/password-reset.integration.spec.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
		fileParallelism: false
	}
});
