/** Human-readable download name; storage keys remain immutable and unique. */
export function sceneDownloadFilename(order: number, title?: string | null, text?: string | null): string {
	const clean = (value: string) =>
		value
			.normalize('NFC')
			.replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
			.replace(/^_+|_+$/g, '');
	const source = clean(title ?? '') || clean(text ?? '') || 'scene';
	const words = source.split('_').slice(0, 6).join('_');
	let label = '';
	// Preserve Hindi vowel marks and other grapheme clusters; keep UTF-8 names short.
	for (const { segment } of new Intl.Segmenter('hi', { granularity: 'grapheme' }).segment(words)) {
		if (Buffer.byteLength(label + segment, 'utf8') > 160) break;
		label += segment;
	}
	const number = Number.isSafeInteger(order) && order > 0 ? order : 1;
	return `${String(number).padStart(3, '0')}_${label.replace(/_+$/g, '') || 'scene'}.wav`;
}
