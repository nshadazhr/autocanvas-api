import { describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ requests: [] as Array<{ model: string }>, clients: 0 }));
vi.mock('@google/genai', async importOriginal => {
	const actual = await importOriginal<typeof import('@google/genai')>();
	return {
		...actual,
		GoogleGenAI: class {
			models = {
				generateContent: async (input: { model: string }) => {
					calls.requests.push(input);
					return { text: 'Gemini connected' };
				}
			};
			constructor() {
				calls.clients++;
			}
		}
	};
});
import { AiService } from './ai.service.js';

function setup() {
	let model: string | null = 'gemini-admin-primary';
	const config = { get: (key: string) => (key === 'AI_DIAGNOSTICS_USER_IDS' ? '9' : 'gemini-environment-old') };
	const settings = { assertEnabled: vi.fn(async () => {}) };
	const execute = vi.fn(async (_user: number, _kind: string, _units: number, action: () => Promise<unknown>) =>
		action()
	);
	const analysis = {
		get: vi.fn(async () => ({ primaryProvider: 'openai', providers: { gemini: { primaryModel: model } } }))
	};
	const service = new AiService(
		config as any,
		{} as any,
		{ execute } as any,
		settings as any,
		{ primary: async () => 'fixture-key' } as any,
		analysis as any
	);
	return {
		service,
		settings,
		execute,
		analysis,
		setModel: (value: string | null) => {
			model = value;
		}
	};
}

describe('Gemini diagnostic model configuration', () => {
	it('uses the saved Gemini primary and picks up admin model changes without restart', async () => {
		calls.requests = [];
		calls.clients = 0;
		const test = setup();
		expect(await test.service.testGemini(9)).toBe('Gemini connected');
		test.setModel('gemini-admin-next');
		await test.service.testGemini(9);
		expect(calls.requests.map(request => request.model)).toEqual(['gemini-admin-primary', 'gemini-admin-next']);
		expect(test.execute).toHaveBeenCalledWith(9, 'diagnostics', 40, expect.any(Function));
		expect(test.settings.assertEnabled).toHaveBeenCalledWith('geminiEnabled');
	});
	it('does not fall through to an environment model when admin has no enabled Gemini primary', async () => {
		const count = calls.clients;
		const test = setup();
		test.setModel(null);
		await expect(test.service.testGemini(9)).rejects.toThrow('Configure an enabled Gemini model');
		expect(test.execute).not.toHaveBeenCalled();
		expect(calls.clients).toBe(count);
	});
	it('keeps diagnostics access restrictions and provider feature checks', async () => {
		const count = calls.clients;
		const test = setup();
		await expect(test.service.testGemini(10)).rejects.toThrow('restricted');
		expect(test.analysis.get).not.toHaveBeenCalled();
		test.settings.assertEnabled.mockRejectedValueOnce(new Error('Gemini disabled'));
		await expect(test.service.testGemini(9)).rejects.toThrow('Gemini disabled');
		expect(calls.clients).toBe(count);
	});
});
