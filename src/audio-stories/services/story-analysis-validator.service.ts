import { Injectable } from '@nestjs/common';

interface AnalysisCharacter {
	name: string;
	gender: string;
}

interface AnalysisScene {
	sceneOrder: number;
	speakerName: string;
	text: string;
	language: string;
	emotion: string;
	style: string;
}

interface AnalysisResult {
	characters: AnalysisCharacter[];
	scenes: AnalysisScene[];
}

@Injectable()
export class StoryAnalysisValidatorService {
	validate(result: AnalysisResult) {
		const errors: string[] = [];

		const characterNames = new Set(result.characters.map(character => character.name.trim()));

		if (result.scenes.length === 0) {
			errors.push('No scenes found');
		}

		for (let i = 0; i < result.scenes.length; i++) {
			const scene = result.scenes[i];
			const expectedOrder = i + 1;

			if (scene.sceneOrder !== expectedOrder) {
				errors.push(`Expected SCENE ${expectedOrder}, found SCENE ${scene.sceneOrder}`);
			}

			if (!scene.speakerName?.trim()) {
				errors.push(`SCENE ${scene.sceneOrder}: Speaker missing`);
			} else if (!characterNames.has(scene.speakerName.trim())) {
				errors.push(`SCENE ${scene.sceneOrder}: Speaker "${scene.speakerName}" not found in characters`);
			}

			if (!scene.text?.trim()) {
				errors.push(`SCENE ${scene.sceneOrder}: Text missing`);
			}

			if (!scene.language?.trim()) {
				errors.push(`SCENE ${scene.sceneOrder}: Language missing`);
			}

			if (!scene.emotion?.trim()) {
				errors.push(`SCENE ${scene.sceneOrder}: Emotion missing`);
			}

			if (!scene.style?.trim()) {
				errors.push(`SCENE ${scene.sceneOrder}: Style missing`);
			}
		}

		return {
			valid: errors.length === 0,
			totalScenes: result.scenes.length,
			errors
		};
	}
}
