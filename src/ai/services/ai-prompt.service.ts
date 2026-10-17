import { Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

@Injectable()
export class AiPromptService {
	private readonly promptDirectory = join(process.cwd(), 'src', 'ai', 'prompts');

	async getPrompt(key: string): Promise<string> {
		// Future: load active prompt from PostgreSQL

		const allowedPrompts: Record<string, string> = {
			'story-analysis': 'story-analysis.txt'
		};
		const filename = allowedPrompts[key];

		if (!filename) {
			throw new NotFoundException(`Prompt not found: ${key}`);
		}

		const filePath = join(this.promptDirectory, filename);

		const prompt = await readFile(filePath, 'utf-8');

		if (!prompt.trim()) {
			throw new Error(`Prompt is empty: ${key}`);
		}

		return prompt;
	}
}
