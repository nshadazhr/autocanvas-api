import { z } from 'zod';

export const AnalyzedCharacterSchema = z.object({
	name: z.string().trim().min(1),
	gender: z.string().trim().min(1)
});

export const AnalyzedSceneSchema = z.object({
	sceneOrder: z.number().int().positive(),
	speakerName: z.string().trim().min(1),
	text: z.string().trim().min(1),
	language: z.string().trim().min(1),
	emotion: z.string().trim().min(1),
	style: z.string().trim().min(1)
});

export const StoryAnalysisSchema = z.object({
	characters: z.array(AnalyzedCharacterSchema).min(1),
	scenes: z.array(AnalyzedSceneSchema).min(1)
});

export type StoryAnalysisResult = z.infer<typeof StoryAnalysisSchema>;
