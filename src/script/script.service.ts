import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { env } from 'process';

@Injectable()
export class ScriptService {
	private readonly openai: OpenAI;

	constructor(private readonly configService: ConfigService) {
		this.openai = new OpenAI({
			apiKey: process.env.OPENAI_API_KEY
		});
	}

	async generateOutline(title: string, language: string) {
		const response = await this.openai.responses.create({
			model: this.configService.get<string>('OPENAI_MODEL', 'gpt-4.1'),
			instructions:
				'You are a Hindi moral story outline writer. Return a short story outline in the requested language.',
			input: `Story Title: ${title}\nLanguage: ${language}`
		});

		return {
			title,
			language,
			outline: response.output_text
		};
	}
}
