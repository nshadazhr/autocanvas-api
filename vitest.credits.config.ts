import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
	cacheDir: join(tmpdir(), 'autocanvas-credits-vitest-cache'),
	test: {
		include: ['src/credits/credits.integration.spec.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
		fileParallelism: false
	}
});
