import { sceneDownloadFilename } from './scene-download-filename.js';

// Shared logical keys: adapters only add their provider/bucket/root.
// Hindi is romanized for Supabase's ASCII object-key restrictions.
const consonants: Record<string, string> = Object.fromEntries(
	Array.from('कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह').map((c, i) => [
		c,
		[
			'k',
			'kh',
			'g',
			'gh',
			'ng',
			'ch',
			'chh',
			'j',
			'jh',
			'ny',
			't',
			'th',
			'd',
			'dh',
			'n',
			't',
			'th',
			'd',
			'dh',
			'n',
			'p',
			'ph',
			'b',
			'bh',
			'm',
			'y',
			'r',
			'l',
			'v',
			'sh',
			'sh',
			's',
			'h'
		][i]
	])
);
const vowels: Record<string, string> = {
	अ: 'a',
	आ: 'aa',
	इ: 'i',
	ई: 'ee',
	उ: 'u',
	ऊ: 'oo',
	ऋ: 'ri',
	ए: 'e',
	ऐ: 'ai',
	ओ: 'o',
	औ: 'au',
	'ा': 'aa',
	'ि': 'i',
	'ी': 'ee',
	'ु': 'u',
	'ू': 'oo',
	'ृ': 'ri',
	'े': 'e',
	'ै': 'ai',
	'ो': 'o',
	'ौ': 'au',
	'ं': 'n',
	'ँ': 'n',
	'ः': 'h',
	'्': '',
	'़': ''
};
export function storageLabel(value: string, fallback: string) {
	const chars = Array.from(value.normalize('NFC'));
	let roman = '';
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i];
		if (consonants[c]) {
			roman += consonants[c];
			const next = chars[i + 1] === '़' ? chars[i + 2] : chars[i + 1];
			if (next && consonants[next]) roman += 'a';
		} else roman += vowels[c] ?? c;
	}
	return (
		roman
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-zA-Z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 90)
			.replace(/_+$/g, '') || fallback
	);
}
export function storyFolder(id: number, title: string | null | undefined, single = false) {
	return `audio-stories/${single ? 'single-voice' : 'multiple-voice'}/story_${id}_${storageLabel(!title?.trim() || /^(untitled audio|untitled|single voice)$/i.test(title.trim()) ? '' : title, 'untitled')}`;
}
export function storyDownloadName(id: number, title?: string | null) {
	if (!title?.trim() || /^(untitled audio|untitled|single voice)$/i.test(title.trim())) return `story_${id}_audio`;
	return sceneDownloadFilename(1, title)
		.replace(/^001_/, '')
		.replace(/\.wav$/, '');
}
export function attachment(filename: string) {
	return `attachment; filename="audio.${filename.endsWith('.zip') ? 'zip' : 'wav'}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
export function ownedExportKey(location: string, storyId: number) {
	const key = location.replace(/^(local|supabase|r2):\/\//, '');
	if (key.split('/').some(p => !p || p === '.' || p === '..')) return false;
	return new RegExp(
		`^audio-stories/multiple-voice/story_${storyId}_[A-Za-z0-9_]+/exports/export-[a-f0-9-]+/[A-Za-z0-9_]+\\.wav$`
	).test(key);
}
