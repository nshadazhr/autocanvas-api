export interface AnalyzedCharacter {
	name: string;
	gender: string;
}

export interface AnalyzedScene {
	sceneOrder: number;
	speakerName: string;
	text: string;
	language: string;
	emotion: string;
	style: string;
}

export interface StoryAnalysisResult {
	characters: AnalyzedCharacter[];
	scenes: AnalyzedScene[];
}
