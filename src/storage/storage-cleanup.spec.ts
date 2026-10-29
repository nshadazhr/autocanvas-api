import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageCleanupService } from './storage-cleanup.service.js';
import { STORAGE_CLEANUP_INTERVAL_MS, STORAGE_CLEANUP_POLL_MS } from './storage-objects.service.js';
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function settings(enabled = true) {
	let value = enabled;
	const section = vi.fn(async () => ({ values: { cleanupEnabled: value } }));
	return {
		section,
		set: (next: boolean) => {
			value = next;
		}
	};
}
describe('runtime-configured cleanup scheduler', () => {
	it('checks configuration every poll but scans hourly and stops on shutdown', async () => {
		vi.useFakeTimers();
		const findMany = vi.fn(async () => []),
			config = settings();
		const worker = new StorageCleanupService({ storageObject: { findMany } } as any, {} as any, config as any);
		worker.onModuleInit();
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_POLL_MS - 1);
		expect(findMany).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(findMany).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_POLL_MS);
		expect(findMany).toHaveBeenCalledTimes(1);
		expect(config.section).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_INTERVAL_MS);
		expect(findMany).toHaveBeenCalledTimes(2);
		worker.onModuleDestroy();
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_INTERVAL_MS * 2);
		expect(findMany).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('resumes after a saved switch changes without restarting the worker', async () => {
		vi.useFakeTimers();
		const findMany = vi.fn(async () => []),
			config = settings(false);
		const worker = new StorageCleanupService({ storageObject: { findMany } } as any, {} as any, config as any);
		worker.onModuleInit();
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_POLL_MS);
		expect(findMany).not.toHaveBeenCalled();
		config.set(true);
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_POLL_MS);
		expect(findMany).toHaveBeenCalledTimes(1);
		config.set(false);
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_POLL_MS);
		config.set(true);
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_POLL_MS);
		expect(findMany).toHaveBeenCalledTimes(2);
		worker.onModuleDestroy();
	});
	it('does not overlap scans or reschedule an in-flight scan after shutdown', async () => {
		vi.useFakeTimers();
		let finish!: (rows: any[]) => void;
		const findMany = vi.fn(
			() =>
				new Promise<any[]>(resolve => {
					finish = resolve;
				})
		);
		const worker = new StorageCleanupService({ storageObject: { findMany } } as any, {} as any, settings() as any);
		worker.onModuleInit();
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_POLL_MS);
		expect(findMany).toHaveBeenCalledTimes(1);
		expect(await worker.runOnce()).toEqual({ deleted: 0 });
		worker.onModuleDestroy();
		finish([]);
		await vi.advanceTimersByTimeAsync(STORAGE_CLEANUP_INTERVAL_MS);
		expect(findMany).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('fails closed if settings cannot be read or contain an invalid value', async () => {
		const findMany = vi.fn(async () => []),
			config = settings();
		config.section.mockRejectedValueOnce(new Error('Settings unavailable'));
		const worker = new StorageCleanupService({ storageObject: { findMany } } as any, {} as any, config as any);
		await expect(worker.runOnce()).rejects.toThrow('Settings unavailable');
		expect(findMany).not.toHaveBeenCalled();
		config.section.mockResolvedValueOnce({ values: { cleanupEnabled: 'false' } } as any);
		await expect(worker.runOnce()).rejects.toThrow('Invalid storage cleanup setting');
		expect(findMany).not.toHaveBeenCalled();
		worker.onModuleDestroy();
	});
});
