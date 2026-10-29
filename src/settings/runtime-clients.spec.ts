import { describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => [] as Array<{ key: string; model: string }>);
vi.mock('openai', () => ({
	default: class {
		responses: { create: (request: any) => Promise<any> };
		constructor(options: { apiKey: string }) {
			this.responses = {
				create: async (request) => {
					calls.push({ key: options.apiKey, model: request.model });
					return { model: request.model, output_text: 'fixture outline' };
				}
			};
		}
	}
}));
import { OpenAIProvider } from '../ai/providers/openai.provider.js';
import { ScriptService } from '../script/script.service.js';
describe('runtime OpenAI outline configuration', () => {
	it('uses new saved keys and models on the next call without restart', async () => {
		calls.length = 0;
		let key = 'fixture-key-one',
			model = 'gpt-fixture-one';
		const settings = {
			assertEnabled: vi.fn().mockResolvedValue(undefined),
			section: async () => ({ values: { outlineModel: model } })
		};
		const provider = new OpenAIProvider({ primary: async () => key } as any, settings as any);
		const service = new ScriptService(settings as any, provider);
		expect(await service.generateOutline('Story', 'Hindi')).toEqual({
			title: 'Story',
			language: 'Hindi',
			outline: 'fixture outline'
		});
		key = 'fixture-key-two';
		model = 'gpt-fixture-two';
		await service.generateOutline('Story', 'Hindi');
		expect(calls).toEqual([
			{ key: 'fixture-key-one', model: 'gpt-fixture-one' },
			{ key: 'fixture-key-two', model: 'gpt-fixture-two' }
		]);
	});
	it('blocks new outlines when disabled without contacting a provider', async () => {
		const provider = { generateText: vi.fn() };
		const service = new ScriptService(
			{
				assertEnabled: async () => {
					throw new Error('Feature disabled');
				}
			} as any,
			provider as any
		);
		await expect(service.generateOutline('Story', 'Hindi')).rejects.toThrow('disabled');
		expect(provider.generateText).not.toHaveBeenCalled();
	});
});
