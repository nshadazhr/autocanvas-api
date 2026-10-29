import { ProviderCredentialsService } from '../settings/provider-credentials.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { AnalysisSettingsService } from '../settings/analysis-settings.service.js';
import { AiUsageService } from './usage/ai-usage.service.js';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { ConfigService } from '@nestjs/config';
import { Type } from '@google/genai';
import { StoryAnalysisSchema, type StoryAnalysisResult } from './schemas/story-analysis.schema.js';
import { AiPromptService } from './services/ai-prompt.service.js';
@Injectable()
export class AiService {
	constructor(
		private readonly configService: ConfigService,
		private readonly aiPromptService: AiPromptService,
		private readonly usage: AiUsageService,
		private readonly settings: AppSettingsService,
		private readonly credentials: ProviderCredentialsService,
		private readonly analysisSettings: AnalysisSettingsService
	) {}

	async assertAnalysisEnabled() {
		await this.settings.assertEnabled('analysisEnabled');
	}
	private async geminiClient() {
		await this.settings.assertEnabled('geminiEnabled');
		return new GoogleGenAI({
			apiKey: await this.credentials.primary('gemini'),
			httpOptions: { timeout: 90_000 }
		});
	}

	assertDiagnosticsAccess(userId: number) {
		const allowed = (this.configService.get<string>('AI_DIAGNOSTICS_USER_IDS') ?? '')
			.split(',')
			.map(value => Number(value.trim()))
			.filter(value => value > 0);
		if (!allowed.includes(userId))
			throw new ForbiddenException('AI diagnostics are restricted to configured administrators');
	}

	async testGemini(userId: number) {
		this.assertDiagnosticsAccess(userId);
		const model = (await this.analysisSettings.get()).providers.gemini.primaryModel;
		if (!model)
			throw new ServiceUnavailableException(
				'Configure an enabled Gemini model in Providers & Models before testing Gemini.'
			);
		return this.usage.execute(userId, 'diagnostics', 40, async () => {
			const response = await (
				await this.geminiClient()
			).models.generateContent({
				model,
				contents: 'Reply with exactly: Gemini connected'
			});
			return response.text;
		});
	}

	async listModels(userId: number) {
		this.assertDiagnosticsAccess(userId);
		return this.usage.execute(userId, 'diagnostics', 1, async () => {
			const models = [];
			for await (const model of await (await this.geminiClient()).models.list())
				models.push({
					name: model.name,
					displayName: model.displayName,
					supportedActions: model.supportedActions
				});
			return models;
		});
	}

	async getAnalysisModel(): Promise<string> {
		return (await this.settings.analysisModel()).model;
	}

	async analyzeStory(
		content: string,
		userId: number,
		selectedModel?: string,
		onRequest?: () => Promise<void>
	): Promise<StoryAnalysisResult> {
		const model = selectedModel ?? (await this.getAnalysisModel());
		const systemInstruction = await this.aiPromptService.getPrompt('story-analysis');
		const response = await this.usage.execute(userId, 'analysis', content.length, async () => {
			const client = await this.geminiClient();
			await onRequest?.();
			return client.models.generateContent({
				model,
				contents: content,
				config: {
					systemInstruction: systemInstruction,
					httpOptions: { retryOptions: { attempts: 1 } },
					maxOutputTokens: 16_384,
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
		});

		if (!response.text) {
			throw new Error('Gemini returned an empty analysis response');
		}

		try {
			return StoryAnalysisSchema.parse(JSON.parse(response.text));
		} catch {
			throw Object.assign(new Error('AI returned invalid analysis data'), {
				code: 'INVALID_ANALYSIS_RESPONSE'
			});
		}
	}

	async generateSpeech(text: string, voiceName: string, model: string, userId: number) {
		if (!text.trim()) {
			throw new Error('Speech text cannot be empty');
		}

		const response = await this.usage.execute(userId, 'tts', text.length, async () =>
			(await this.geminiClient()).models.generateContent({
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
			})
		);

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

	async getGeminiStudioVoices(userId: number) {
		this.assertDiagnosticsAccess(userId);
		await this.settings.assertEnabled('geminiEnabled');
		const ai = new GoogleGenAI({
			apiKey: await this.credentials.primary('gemini'),
			httpOptions: { timeout: 90_000 }
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
			const response = await this.usage.execute(userId, 'diagnostics', 1, () =>
				ai.voices.list({
					page_size: 1000,
					...(pageToken ? { page_token: pageToken } : {})
				})
			);

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
