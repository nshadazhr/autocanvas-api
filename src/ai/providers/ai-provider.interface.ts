export type AIProviderName = 'openai' | 'gemini' | 'grok';

export interface AITextRequest {
	model: string;
	systemPrompt: string;
	userPrompt: string;
	temperature?: number;
	maxOutputTokens?: number;
}

export interface AITextResponse {
	provider: AIProviderName;
	model: string;
	text: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface AIProvider {
	generateText(request: AITextRequest): Promise<AITextResponse>;
}
