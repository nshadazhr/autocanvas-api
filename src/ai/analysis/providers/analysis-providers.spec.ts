import { describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ options: [] as any[], requests: [] as any[], text: '' }));
vi.mock('openai', () => ({
	default: class {
		responses: any;
		constructor(options: any) {
			calls.options.push(options);
			this.responses = {
				create: async (request: any) => {
					calls.requests.push(request);
					return { model: request.model, output_text: calls.text };
				}
			};
		}
	}
}));
import { OpenAIProvider } from '../../providers/openai.provider.js';
import { OpenAIAnalysisProvider } from './openai-analysis.provider.js';
import { GeminiAnalysisProvider } from './gemini-analysis.provider.js';
const output = {
	characters: [{ name: 'Narrator', gender: 'Male' }],
	scenes: [
		{
			sceneOrder: 1,
			speakerName: 'Narrator',
			text: 'नमस्ते',
			language: 'hi-IN',
			emotion: 'neutral',
			style: 'narration'
		}
	]
};
describe('analysis provider adapters', () => {
	it('reuses the OpenAI client with strict shared JSON schema, no hidden retries, and validates the output', async () => {
		calls.text = JSON.stringify(output);
		const credentials = { primary: vi.fn(async () => 'fixture-key') };
		const settings = { assertEnabled: vi.fn(async () => {}) };
		const provider = new OpenAIAnalysisProvider(
			new OpenAIProvider(credentials as any, settings as any),
			{ getPrompt: async () => 'fixture prompt' } as any,
			{ execute: async (_u: any, _kind: any, _length: any, fn: any) => fn() } as any
		);
		expect(await provider.analyze('कहानी', 4, 'configured-model')).toEqual(output);
		expect(credentials.primary).toHaveBeenCalledWith('openai');
		expect(settings.assertEnabled).toHaveBeenCalledWith('openaiEnabled');
		expect(calls.options.at(-1)).toMatchObject({ maxRetries: 0, timeout: 90000 });
		expect(calls.requests.at(-1)).toMatchObject({
			model: 'configured-model',
			store: false,
			text: {
				format: {
					type: 'json_schema',
					strict: true,
					schema: { additionalProperties: false, required: ['characters', 'scenes'] }
				}
			}
		});
		calls.text = '{"characters":[]}';
		await expect(provider.analyze('story', 4, 'configured-model')).rejects.toMatchObject({
			code: 'INVALID_ANALYSIS_RESPONSE'
		});
	});
	it('does not dispatch OpenAI if the tracking/ownership hook rejects', async () => {
		const before = calls.requests.length;
		const provider = new OpenAIProvider(
			{ primary: async () => 'fixture-key' } as any,
			{ assertEnabled: async () => {} } as any
		);
		await expect(
			provider.generateText({
				model: 'fixture',
				userPrompt: 'story',
				systemPrompt: 'prompt',
				jsonSchema: {},
				onRequest: async () => {
					throw new Error('Ownership expired');
				}
			})
		).rejects.toThrow('Ownership expired');
		expect(calls.requests.length).toBe(before);
	});

	it('delegates Gemini to the existing schema and prompt implementation', async () => {
		const ai = { analyzeStory: vi.fn(async () => output) };
		expect(await new GeminiAnalysisProvider(ai as any).analyze('story', 4, 'g1')).toEqual(output);
		expect(ai.analyzeStory).toHaveBeenCalledWith('story', 4, 'g1', undefined);
	});
});
