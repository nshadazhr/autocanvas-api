import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { ConfigService } from '@nestjs/config';
import { Type } from '@google/genai';
import { StoryAnalysisSchema, type StoryAnalysisResult } from './schemas/story-analysis.schema.js';
import { AiPromptService } from './services/ai-prompt.service.js';
@Injectable()
export class AiService {
	private readonly gemini: GoogleGenAI;

	constructor(
		private readonly configService: ConfigService,
		private readonly aiPromptService: AiPromptService
	) {
		const apiKey = process.env.GEMINI_API_KEY;

		this.gemini = new GoogleGenAI({
			apiKey
		});
	}

	async testGemini() {
		const maxAttempts = 3;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const response = await this.gemini.models.generateContent({
					model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
					contents: 'Reply with exactly: Gemini connected'
				});

				return response.text;
			} catch (error: any) {
				const status = error.status ?? error.code;

				if (status !== 503 || attempt === maxAttempts) {
					throw error;
				}

				const delay = 1000 * Math.pow(2, attempt - 1);

				console.log(`Gemini unavailable. Retry ${attempt}/${maxAttempts - 1} after ${delay}ms`);

				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
	}

	async listModels() {
		const models = [];

		const response = await this.gemini.models.list();

		for await (const model of response) {
			models.push({
				name: model.name,
				displayName: model.displayName,
				supportedActions: model.supportedActions
			});
		}

		return models;
	}

	async analyzeStory(content: string): Promise<StoryAnalysisResult> {
		const model = this.configService.get<string>('GEMINI_MODEL', 'gemini-3.5-flash');
		const systemInstruction = await this.aiPromptService.getPrompt('story-analysis');
		const response = await this.gemini.models.generateContent({
			model,
			contents: content,
			config: {
				systemInstruction: systemInstruction,
				responseMimeType: 'application/json',
				responseSchema: {
					type: Type.OBJECT,
					properties: {
						characters: {
							type: Type.ARRAY,
							items: {
								type: Type.OBJECT,
								properties: {
									name: { type: Type.STRING },
									gender: { type: Type.STRING }
								},
								required: ['name', 'gender']
							}
						},
						scenes: {
							type: Type.ARRAY,
							items: {
								type: Type.OBJECT,
								properties: {
									sceneOrder: { type: Type.INTEGER },
									speakerName: { type: Type.STRING },
									text: { type: Type.STRING },
									language: { type: Type.STRING },
									emotion: { type: Type.STRING },
									style: { type: Type.STRING }
								},
								required: ['sceneOrder', 'speakerName', 'text', 'language', 'emotion', 'style']
							}
						}
					},
					required: ['characters', 'scenes']
				}
			}
		});

		if (!response.text) {
			throw new Error('Gemini returned an empty analysis response');
		}

		const result: unknown = JSON.parse(response.text);

		return StoryAnalysisSchema.parse(result);
	}

	async generateSpeech(text: string, voiceName: string, model: string) {
		if (!text.trim()) {
			throw new Error('Speech text cannot be empty');
		}

		const response = await this.gemini.models.generateContent({
			model,
			contents: [
				{
					role: 'user',
					parts: [{ text }]
				}
			],
			config: {
				responseModalities: ['AUDIO'],
				speechConfig: {
					voiceConfig: {
						prebuiltVoiceConfig: {
							voiceName
						}
					}
				}
			}
		});

		const parts = response.candidates?.[0]?.content?.parts ?? [];

		const audioPart = parts.find(part => part.inlineData?.data);

		console.log('TTS Response:', {
			finishReason: response.candidates?.[0]?.finishReason,
			mimeType: audioPart?.inlineData?.mimeType,
			audioReceived: Boolean(audioPart?.inlineData?.data),
			audioBase64Length: audioPart?.inlineData?.data?.length ?? 0
		});

		return response;
	}
}
