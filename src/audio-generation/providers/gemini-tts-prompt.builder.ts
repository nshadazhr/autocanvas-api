export interface GeminiTtsPromptOptions {
	text: string;
	speaker?: string | null;
	stylePrompt?: string | null;
	style?: string | null;
	emotion?: string | null;
	pacing?: string | null;
	speed?: number | null;
	pitch?: number | null;
	languageLabel?: string | null;
	neutralFallback?: boolean;
}

function sentence(value: string): string {
	const text = value.trim();
	if (!text) return '';
	return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function speedNote(speed: number): string {
	if (!Number.isFinite(speed) || Math.abs(speed - 1) < 0.03) return '';
	if (speed <= 0.7) return 'Pacing: very slow and deliberate, with generous pauses.';
	if (speed <= 0.9) return 'Pacing: slower than normal, unhurried.';
	if (speed >= 1.4) return 'Pacing: very fast, urgent, minimal pauses.';
	if (speed >= 1.1) return 'Pacing: brisk, slightly faster than normal.';
	return '';
}

function pitchNote(pitch: number): string {
	if (!Number.isFinite(pitch) || Math.abs(pitch) < 0.5) return '';
	if (pitch <= -6) return 'Register: very deep and low.';
	if (pitch < 0) return 'Register: slightly lower and warmer than usual.';
	if (pitch >= 6) return 'Register: noticeably high and light.';
	return 'Register: slightly brighter and higher than usual.';
}

export function buildStylePrompt(request: GeminiTtsPromptOptions): string {
	if (request.neutralFallback) {
		return [
			'Synthesize speech for the transcript below.',
			'Speak naturally and clearly in the original language.',
			'Read only the transcript aloud; never read these instructions.',
			'TRANSCRIPT:',
			request.text.trim()
		].join('\n');
	}

	const notes: string[] = [];

	if (request.stylePrompt?.trim()) {
		notes.push(request.stylePrompt.trim());
	} else {
		if (request.speaker) {
			if (request.speaker.toLowerCase() !== 'narrator') {
				notes.push(sentence(`Character: ${request.speaker}`));
			} else {
				notes.push('Role: story narrator.');
			}
		}

		if (request.style) {
			const style = request.style.trim();
			if (style) {
				notes.push(sentence(style.length > 80 ? style : `Style: ${style}`));
			}
		}

		if (request.emotion && !['auto', 'none', ''].includes(request.emotion.toLowerCase())) {
			notes.push(sentence(`Emotion: ${request.emotion}`));
		}
		if (request.pacing) notes.push(sentence(`Pacing: ${request.pacing}`));

		if (request.speed != null) {
			const note = speedNote(request.speed);
			if (note) notes.push(note);
		}
		if (request.pitch != null) {
			const note = pitchNote(request.pitch);
			if (note) notes.push(note);
		}
		if (request.languageLabel) {
			notes.push(`Language: ${request.languageLabel}. Keep pronunciation native.`);
		}
	}

	const header = [
		'Synthesize speech for the transcript below. Read only the transcript aloud; never read these instructions.'
	];
	if (notes.length) header.push(`DIRECTOR'S NOTES: ${notes.join(' ')}`);
	header.push('TRANSCRIPT:');
	return `${header.join('\n')}\n${request.text.trim()}`;
}
