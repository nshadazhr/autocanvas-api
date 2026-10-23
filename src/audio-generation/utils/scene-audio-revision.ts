import { createHash } from 'node:crypto';

type Scene = {
	text: string;
	speakerName: string | null;
	language: string;
	emotion: string | null;
	style: string | null;
};
type Voice = { id: number; provider: string; providerVoiceId: string; model: string };

export function sceneAudioRevision(scene: Scene, voice: Voice) {
	return createHash('sha256')
		.update(
			JSON.stringify([
				scene.text,
				scene.speakerName,
				scene.language,
				scene.emotion,
				scene.style,
				voice.id,
				voice.provider,
				voice.providerVoiceId,
				voice.model
			])
		)
		.digest('hex');
}

export function isCurrentSceneAudio(
	scene: Scene & { updated_at: Date },
	voice: Voice | null,
	audio: {
		textSnapshot: string;
		voiceId: number;
		provider: string;
		providerVoiceId: string;
		model: string;
		settingsSnapshot: unknown;
		created_at: Date;
	}
) {
	if (!voice || audio.textSnapshot !== scene.text || audio.voiceId !== voice.id) return false;
	if (
		audio.provider !== voice.provider ||
		audio.providerVoiceId !== voice.providerVoiceId ||
		audio.model !== voice.model
	)
		return false;
	const settings = audio.settingsSnapshot as { revision?: string } | null;
	return settings?.revision
		? settings.revision === sceneAudioRevision(scene, voice)
		: audio.created_at >= scene.updated_at;
}
