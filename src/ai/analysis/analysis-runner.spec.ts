import { describe, expect, it } from 'vitest';
import { AnalysisRun } from './analysis-runner.service.js';
import { classifyAnalysisError } from './analysis-errors.js';
import { defaultAnalysisSettings, validateAnalysisSettings } from '../../settings/analysis-settings.service.js';
const busy = () => Object.assign(new Error('busy'), { status: 503 });
function settings() {
	return {
		...defaultAnalysisSettings('g1'),
		providerFallback: true,
		retryLimit: 2,
		retryDelaySeconds: 7,
		providers: {
			gemini: {
				primaryModel: 'g1',
				models: [
					{ id: 'g2', enabled: true },
					{ id: 'off', enabled: false },
					{ id: 'g1', enabled: true },
					{ id: 'g3', enabled: true }
				]
			},
			openai: {
				primaryModel: 'o1',
				models: [
					{ id: 'o1', enabled: true },
					{ id: 'o2', enabled: true }
				]
			}
		}
	};
}
describe('analysis routing and validation', () => {
	it('tries enabled models once, providers in order, then only the original primary with a finite delay', () => {
		const run = new AnalysisRun(settings());
		const calls = [run.current];
		for (let i = 0; i < 6; i++) calls.push(run.afterFailure(busy())!);
		expect(calls.map(c => [c.provider, c.model, c.delayMs])).toEqual([
			['gemini', 'g1', 0],
			['gemini', 'g2', 0],
			['gemini', 'g3', 0],
			['openai', 'o1', 0],
			['openai', 'o2', 0],
			['gemini', 'g1', 7000],
			['gemini', 'g1', 7000]
		]);
		expect(run.afterFailure(busy())).toBeNull();
	});
	it('supports OpenAI as primary and provider-only mode', () => {
		const config = { ...settings(), primaryProvider: 'openai' as const, providerFallback: false, retryLimit: 0 };
		const run = new AnalysisRun(config);
		expect(run.current.model).toBe('o1');
		expect(run.afterFailure(busy())?.model).toBe('o2');
		expect(run.afterFailure(busy())).toBeNull();
	});
	it('works with only one primary and no backups or delayed retries', () => {
		const run = new AnalysisRun({ ...defaultAnalysisSettings('g1'), retryLimit: 0 });
		expect(run.afterFailure(busy())).toBeNull();
	});
	it('skips the whole rate-limited provider and never returns to its primary', () => {
		const run = new AnalysisRun(settings());
		expect(run.afterFailure(Object.assign(new Error('rate limit'), { status: 429 }))?.model).toBe('o1');
		expect(run.afterFailure(busy())?.model).toBe('o2');
		expect(run.afterFailure(busy())).toBeNull();
	});
	it('can return to a healthy primary after only the backup provider quota is exhausted', () => {
		const run = new AnalysisRun(settings());
		run.afterFailure(busy());
		run.afterFailure(busy());
		run.afterFailure(busy());
		expect(run.afterFailure(Object.assign(new Error('quota exhausted'), { status: 429 }))?.model).toBe('g1');
	});
	it('stops invalid keys, permissions, request errors, invalid output and network errors', () => {
		for (const error of [
			Object.assign(new Error('API_KEY_INVALID'), { status: 400 }),
			Object.assign(new Error('denied'), { status: 403 }),
			Object.assign(new Error('invalid request'), { status: 400 }),
			Object.assign(new Error('invalid'), { code: 'INVALID_ANALYSIS_RESPONSE' }),
			new Error('fetch failed'),
			new Error('Connection error.'),
			new Error('Request timed out.')
		])
			expect(new AnalysisRun(settings()).afterFailure(error)).toBeNull();
	});
	it('distinguishes explicit exhausted quota, generic rate limiting, local configuration and unknown status', () => {
		expect(classifyAnalysisError({ status: 429, code: 'insufficient_quota' }).kind).toBe('QUOTA_EXHAUSTED');
		expect(classifyAnalysisError({ response: { status: 429 }, code: 'RESOURCE_EXHAUSTED' }).kind).toBe(
			'RATE_LIMITED'
		);
		expect(classifyAnalysisError({ status: 503, nonRetryable: true }).kind).toBe('CONFIGURATION');
		expect(classifyAnalysisError({ code: 99999 }).httpStatus).toBeNull();
	});
	it('captures configuration for running jobs independently of later mutations', () => {
		const config = defaultAnalysisSettings('g1');
		const run = new AnalysisRun(config);
		config.providers.gemini.primaryModel = 'changed';
		config.retryLimit = 0;
		expect(run.afterFailure(busy())?.model).toBe('g1');
	});
	it('rejects disabled/removed primary, duplicates, missing providers, unknown fields and invalid bounds', () => {
		const base = settings();
		for (const invalid of [
			{ ...base, retryLimit: 11 },
			{ ...base, retryDelaySeconds: 0 },
			{ ...base, apiKey: 'secret' },
			{
				...base,
				providers: { ...base.providers, gemini: { primaryModel: 'g1', models: [{ id: 'g1', enabled: false }] } }
			},
			{ ...base, providers: { ...base.providers, openai: { primaryModel: null, models: [] } } },
			{
				...base,
				providers: {
					...base.providers,
					gemini: {
						primaryModel: 'g1',
						models: [
							{ id: 'g1', enabled: true },
							{ id: 'g1', enabled: true }
						]
					}
				}
			}
		])
			expect(() => validateAnalysisSettings(invalid)).toThrow();
		expect(validateAnalysisSettings(defaultAnalysisSettings('g1')).providerFallback).toBe(false);
	});
});
