import type { Prisma, AnalysisAttemptStatus } from '../../generated/prisma/client.js';
import { safeAiError } from '../usage/safe-ai-error.js';
export function safeAnalysisDetail(error: unknown) {
	return safeAiError(error)
		.replace(/sk-[a-zA-Z0-9_-]{6,}/g, '[redacted]')
		.replace(/((?:api[_-]?key|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}
export function providerErrorCode(error: unknown): string | null {
	const e = error as { code?: unknown; error?: { code?: unknown } };
	const code = e?.error?.code ?? e?.code;
	return typeof code === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(code) && !/^sk-|AIza/i.test(code) ? code : null;
}
export async function finishAnalysisAttempt(
	tx: Prisma.TransactionClient,
	id: string,
	status: Exclude<AnalysisAttemptStatus, 'RUNNING'>,
	details: {
		errorCategory?: string;
		providerHttpStatus?: number | null;
		providerErrorCode?: string | null;
		errorMessage?: string;
	} = {},
	finishedAt = new Date()
) {
	const row = await tx.storyAnalysisAttempt.findFirst({
		where: { id, status: 'RUNNING' },
		select: { startedAt: true }
	});
	if (!row) return;
	await tx.storyAnalysisAttempt.updateMany({
		where: { id, status: 'RUNNING' },
		data: {
			status,
			finishedAt,
			durationMs: Math.min(2147483647, Math.max(0, finishedAt.getTime() - row.startedAt.getTime())),
			...details
		}
	});
}
export async function finishOpenAnalysisAttempts(
	tx: Prisma.TransactionClient,
	jobId: string,
	status: 'CANCELLED' | 'INTERRUPTED',
	code: string
) {
	const rows = await tx.storyAnalysisAttempt.findMany({ where: { jobId, status: 'RUNNING' }, select: { id: true } });
	for (const row of rows) await finishAnalysisAttempt(tx, row.id, status, { errorCategory: code });
}
