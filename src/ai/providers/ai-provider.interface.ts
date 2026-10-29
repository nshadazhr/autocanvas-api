export type AIProviderName = 'openai' | 'gemini' | 'grok';

export interface AITextRequest {
	model: string;
	systemPrompt: string;
	userPrompt: string;
	temperature?: number;
	maxOutputTokens?: number;
	jsonSchema?: Record<string, unknown>;
	onRequest?: () => Promise<void>;
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
