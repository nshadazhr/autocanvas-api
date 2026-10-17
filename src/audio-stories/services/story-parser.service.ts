import { Injectable } from '@nestjs/common';

export interface ParsedSceneHeading {
	sceneNumber: number;
	partNumber: number | null;
}

@Injectable()
export class StoryParserService {
	parseHeadings(content: string): ParsedSceneHeading[] {
		const scenes: ParsedSceneHeading[] = [];
		const lines = content.split(/\r?\n/);

		let currentPart: number | null = null;

		for (const line of lines) {
			const normalized = line
				.trim()
				.replace(/^#{1,6}\s*/, '')
				.replace(/^\*{1,2}|\*{1,2}$/g, '')
				.trim();

			// PART 1 / **PART 1**
			const partMatch = normalized.match(/^PART\s+(\d+)$/i);

			if (partMatch) {
				currentPart = Number(partMatch[1]);
				continue;
			}

			// SCENE 1 / ### SCENE 1
			const sceneMatch = normalized.match(/^SCENE\s+(\d+)$/i);

			if (sceneMatch) {
				scenes.push({
					sceneNumber: Number(sceneMatch[1]),
					partNumber: currentPart
				});
			}
		}

		return scenes;
	}

	validateSceneNumbers(scenes: ParsedSceneHeading[]) {
		const errors: string[] = [];
		const seen = new Set<number>();

		for (let i = 0; i < scenes.length; i++) {
			const sceneNumber = scenes[i].sceneNumber;
			const expectedNumber = i + 1;

			if (seen.has(sceneNumber)) {
				errors.push(`Duplicate SCENE ${sceneNumber}`);
			}

			if (sceneNumber !== expectedNumber) {
				errors.push(`Expected SCENE ${expectedNumber}, found SCENE ${sceneNumber}`);
			}

			seen.add(sceneNumber);
		}

		if (scenes.length === 0) {
			errors.push('No SCENE headings found');
		}

		return {
			valid: errors.length === 0,
			totalScenes: scenes.length,
			errors
		};
	}

	parseScenes(content: string) {
		const scenes: {
			partNumber: number | null;
			sceneNumber: number;
			speakerName: string;
			gender: string;
			emotion: string;
			style: string;
			text: string;
		}[] = [];

		const lines = content.split(/\r?\n/);

		let currentPart: number | null = null;
		let currentScene: (typeof scenes)[number] | null = null;
		let dialogueLines: string[] = [];

		const normalizeHeading = (line: string) =>
			line
				.trim()
				.replace(/^#{1,6}\s*/, '')
				.replace(/^\*{1,2}|\*{1,2}$/g, '')
				.trim();

		const saveScene = () => {
			if (!currentScene) return;

			// Remove only surrounding blank lines.
			// Preserve dialogue lines and their internal spacing.
			while (dialogueLines.length && !dialogueLines[0].trim()) {
				dialogueLines.shift();
			}

			while (dialogueLines.length && !dialogueLines[dialogueLines.length - 1].trim()) {
				dialogueLines.pop();
			}

			currentScene.text = dialogueLines.join('\n');
			scenes.push(currentScene);

			currentScene = null;
			dialogueLines = [];
		};

		for (const line of lines) {
			const normalized = normalizeHeading(line);

			const partMatch = normalized.match(/^PART\s+(\d+)$/i);

			if (partMatch) {
				saveScene();
				currentPart = Number(partMatch[1]);
				continue;
			}

			const sceneMatch = normalized.match(/^SCENE\s+(\d+)$/i);

			if (sceneMatch) {
				saveScene();

				currentScene = {
					partNumber: currentPart,
					sceneNumber: Number(sceneMatch[1]),
					speakerName: '',
					gender: '',
					emotion: '',
					style: '',
					text: ''
				};

				continue;
			}

			if (!currentScene) continue;

			const ttsMatch = normalized.match(/^(?:🎙️\s*)?TTS\s+PROMPT\s*[—–-]\s*([^|]+)\|([^|]+)\|(.+)$/i);

			if (ttsMatch) {
				currentScene.speakerName = ttsMatch[1].trim();
				currentScene.gender = ttsMatch[2].trim();

				const emotionAndStyle = ttsMatch[3].split(',');

				currentScene.emotion = emotionAndStyle[0]?.trim() ?? '';
				currentScene.style = emotionAndStyle.slice(1).join(',').trim();

				continue;
			}

			dialogueLines.push(line);
		}

		saveScene();

		return scenes;
	}

	validateParsedScenes(scenes: ReturnType<StoryParserService['parseScenes']>) {
		const errors: string[] = [];

		// Existing numbering validation reuse
		const numbering = this.validateSceneNumbers(scenes);
		errors.push(...numbering.errors);

		for (const scene of scenes) {
			const prefix = `SCENE ${scene.sceneNumber}`;

			if (!scene.speakerName) {
				errors.push(`${prefix}: Speaker name missing`);
			}

			if (!scene.gender) {
				errors.push(`${prefix}: Gender missing`);
			}

			if (!scene.emotion) {
				errors.push(`${prefix}: Emotion missing`);
			}

			if (!scene.style) {
				errors.push(`${prefix}: Style missing`);
			}

			if (!scene.text.trim()) {
				errors.push(`${prefix}: Dialogue missing`);
			}
		}

		return {
			valid: errors.length === 0,
			totalScenes: scenes.length,
			errors
		};
	}
}
