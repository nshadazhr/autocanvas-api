import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioGenerationService } from './audio-generation.service.js';

describe('admin-configured audio retry scanner', () => {
	let service: audioGenerationService;
	afterEach(() => {
		service?.onModuleDestroy();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	function setup() {
		vi.useFakeTimers();
		let interval = 30000;
		const section = vi.fn(async () => ({ values: { retryScanIntervalMs: interval } }));
		service = new audioGenerationService(
			{} as any,
			{} as any,
			{ get: () => '45000' } as any,
			{} as any,
			{ section } as any,
			{} as any
		);
		vi.spyOn(service, 'recoverInterruptedJobs').mockResolvedValue(0);
		const scan = vi
			.spyOn(service as unknown as { resumeWaitingJobs: () => Promise<void> }, 'resumeWaitingJobs')
			.mockResolvedValue(undefined);
		return {
			section,
			scan,
			change: (next: number) => {
				interval = next;
			}
		};
	}
	it('uses the saved interval, picks up edits after the next scan and stops on shutdown', async () => {
		const { scan, change } = setup();
		await service.onModuleInit();
		expect(scan).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29999);
		expect(scan).toHaveBeenCalledTimes(1);
		change(10000);
		await vi.advanceTimersByTimeAsync(1);
		expect(scan).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10000);
		expect(scan).toHaveBeenCalledTimes(3);
		service.onModuleDestroy();
		await vi.advanceTimersByTimeAsync(60000);
		expect(scan).toHaveBeenCalledTimes(3);
	});
	it('continues scanning after scan/config failures using the last valid interval', async () => {
		const { scan, section } = setup();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await service.onModuleInit();
		scan.mockRejectedValueOnce(new Error('DB unavailable'));
		section.mockRejectedValueOnce(new Error('Settings unavailable'));
		await vi.advanceTimersByTimeAsync(30000);
		expect(scan).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30000);
		expect(scan).toHaveBeenCalledTimes(3);
	});
	it('does not overlap scans or reschedule when shut down during an active scan', async () => {
		const { scan } = setup();
		await service.onModuleInit();
		let finish!: () => void;
		scan.mockImplementationOnce(
			() =>
				new Promise<void>(resolve => {
					finish = resolve;
				})
		);
		await vi.advanceTimersByTimeAsync(30000);
		await vi.advanceTimersByTimeAsync(90000);
		expect(scan).toHaveBeenCalledTimes(2);
		service.onModuleDestroy();
		finish();
		await vi.advanceTimersByTimeAsync(60000);
		expect(scan).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
});
