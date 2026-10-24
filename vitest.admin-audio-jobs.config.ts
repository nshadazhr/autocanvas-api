import { defineConfig } from 'vitest/config';
export default defineConfig({
	cacheDir: '/private/tmp/autocanvas-admin-audio-jobs-vitest-cache',
	test: {
		globals: true,
		include: ['src/admin/admin-audio-jobs.integration.spec.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
		fileParallelism: false
	}
});
