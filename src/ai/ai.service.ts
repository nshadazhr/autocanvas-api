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

	async getGeminiStudioVoices() {
		const ai = new GoogleGenAI({
			apiKey: process.env.GEMINI_API_KEY!
		});

		// Keep your existing studioVoices array of 30 voices unchanged
		const studioVoices = [
			{ geminiVoiceName: 'Puck', indianVoiceName: 'Aarav' },
			{ geminiVoiceName: 'Charon', indianVoiceName: 'Vikram' },
			{ geminiVoiceName: 'Fenrir', indianVoiceName: 'Rudra' },
			{ geminiVoiceName: 'Orus', indianVoiceName: 'Pratap' },
			{ geminiVoiceName: 'Algenib', indianVoiceName: 'Raghav' },
			{ geminiVoiceName: 'Algieba', indianVoiceName: 'Mohan' },
			{ geminiVoiceName: 'Schedar', indianVoiceName: 'Suresh' },
			{ geminiVoiceName: 'Achird', indianVoiceName: 'Rahul' },
			{ geminiVoiceName: 'Zubenelgenubi', indianVoiceName: 'Karan' },
			{ geminiVoiceName: 'Sadachbia', indianVoiceName: 'Aditya' },
			{ geminiVoiceName: 'Sadaltager', indianVoiceName: 'Devendra' },
			{ geminiVoiceName: 'Alnilam', indianVoiceName: 'Arjun' },
			{ geminiVoiceName: 'Rasalgethi', indianVoiceName: 'Mahendra' },
			{ geminiVoiceName: 'Enceladus', indianVoiceName: 'Kabir' },
			{ geminiVoiceName: 'Iapetus', indianVoiceName: 'Vivek' },
			{ geminiVoiceName: 'Umbriel', indianVoiceName: 'Rohit' },

			{ geminiVoiceName: 'Kore', indianVoiceName: 'Priya' },
			{ geminiVoiceName: 'Zephyr', indianVoiceName: 'Anjali' },
			{ geminiVoiceName: 'Leda', indianVoiceName: 'Riya' },
			{ geminiVoiceName: 'Aoede', indianVoiceName: 'Kavya' },
			{ geminiVoiceName: 'Callirrhoe', indianVoiceName: 'Neha' },
			{ geminiVoiceName: 'Autonoe', indianVoiceName: 'Ishita' },
			{ geminiVoiceName: 'Despina', indianVoiceName: 'Meera' },
			{ geminiVoiceName: 'Erinome', indianVoiceName: 'Nisha' },
			{ geminiVoiceName: 'Laomedeia', indianVoiceName: 'Pooja' },
			{ geminiVoiceName: 'Achernar', indianVoiceName: 'Sneha' },
			{ geminiVoiceName: 'Gacrux', indianVoiceName: 'Savitri' },
			{ geminiVoiceName: 'Pulcherrima', indianVoiceName: 'Shreya' },
			{ geminiVoiceName: 'Vindemiatrix', indianVoiceName: 'Radha' },
			{ geminiVoiceName: 'Sulafat', indianVoiceName: 'Sunita' }
		];

		const allGeminiVoices = [];
		let pageToken: string | undefined;

		do {
			const response = await ai.voices.list({
				page_size: 1000,
				...(pageToken ? { page_token: pageToken } : {})
			});

			allGeminiVoices.push(...(response.voices ?? []));
			pageToken = response.next_page_token;
		} while (pageToken);

		const studioVoiceMap = new Map(studioVoices.map(voice => [voice.geminiVoiceName.toLowerCase(), voice]));

		const filteredVoices = allGeminiVoices.flatMap(voice => {
			if (voice.type !== 'prebuilt' || !voice.display_name) {
				return [];
			}

			const studio = studioVoiceMap.get(voice.display_name.toLowerCase());

			if (!studio) {
				return [];
			}

			return [
				{
					...voice,
					geminiVoiceName: studio.geminiVoiceName,
					indianVoiceName: studio.indianVoiceName
				}
			];
		});

		if (filteredVoices.length !== studioVoices.length) {
			throw new Error(
				`Gemini voice sync incomplete: Expected ${studioVoices.length}, found ${filteredVoices.length}`
			);
		}

		return filteredVoices;
	}
}
