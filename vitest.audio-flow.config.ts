import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	cacheDir: join(tmpdir(), 'autocanvas-audio-vitest-cache'),
	test: {
		globals: true,
		include: [
			'src/ai/analysis/**/*.spec.ts',
			'src/audio-generation/audio-flow.integration.spec.ts',
			'src/audio-generation/retry-scanner.spec.ts',
			'src/storage/audio-layout.spec.ts',
			'src/storage/r2-storage.spec.ts',
			'src/storage/storage-cleanup.integration.spec.ts',
			'src/storage/storage-cleanup.spec.ts',
			'src/audio-generation/providers/gemini-tts.spec.ts',
			'src/audio-stories/analysis-flow.integration.spec.ts'
		],
		testTimeout: 20_000,
		hookTimeout: 20_000,
		fileParallelism: false
	}
});
