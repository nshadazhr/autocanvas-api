import { isInvalidProviderKey } from '../usage/safe-ai-error.js';
export type AnalysisErrorKind =
	| 'BUSY'
	| 'RATE_LIMITED'
	| 'QUOTA_EXHAUSTED'
	| 'CONFIGURATION'
	| 'ACCESS'
	| 'NETWORK'
	| 'INVALID_RESPONSE'
	| 'FAILED';
export function classifyAnalysisError(error: unknown): { kind: AnalysisErrorKind; httpStatus: number | null } {
	const e = error as {
		status?: unknown;
		code?: unknown;
		response?: { status?: unknown };
		getStatus?: () => number;
		message?: string;
		nonRetryable?: boolean;
		error?: { code?: string; type?: string };
	};
	const status = Number(e?.status ?? e?.response?.status ?? e?.getStatus?.() ?? e?.code);
	const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
	const code = String(e?.error?.code ?? e?.code ?? e?.error?.type ?? '');
	const message = e?.message ?? '';
	let kind: AnalysisErrorKind = 'FAILED';
	if (e?.nonRetryable || isInvalidProviderKey(error)) kind = 'CONFIGURATION';
	else if ([401, 403].includes(status)) kind = 'ACCESS';
	else if (status === 429) {
		kind = /insufficient_quota|billing_hard_limit|quota.*(?:exceed|exhaust)|daily.*limit|per.?day/i.test(
			code + ' ' + message
		)
			? 'QUOTA_EXHAUSTED'
			: 'RATE_LIMITED';
	} else if ([500, 502, 503, 504].includes(status)) kind = 'BUSY';
	else if (/ECONN|ENOTFOUND|fetch failed|network|timeout|timed out|connection error|abort/i.test(message))
		kind = 'NETWORK';
	else if (code === 'INVALID_ANALYSIS_RESPONSE') kind = 'INVALID_RESPONSE';
	return { kind, httpStatus };
}
