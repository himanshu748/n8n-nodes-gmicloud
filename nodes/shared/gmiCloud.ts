export const DEFAULT_BASE_URL = 'https://api.gmi-serving.com/v1';

export type ChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
};

export type ModelOption = {
	name: string;
	value: string;
};

/**
 * Normalise a GMI Cloud API base URL.
 * Defaults to the public inference endpoint, including the `/v1` prefix,
 * and strips a trailing slash so paths like `/models` join cleanly.
 */
export function normalizeBaseUrl(url: unknown): string {
	const raw = typeof url === 'string' ? url.trim() : '';
	const value = raw.length > 0 ? raw : DEFAULT_BASE_URL;
	return value.replace(/\/+$/, '');
}

/**
 * Turn a GET /v1/models payload into n8n option items, sorted by id.
 */
export function parseModelOptions(response: unknown): ModelOption[] {
	if (!response || typeof response !== 'object') {
		return [];
	}

	const data = (response as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		return [];
	}

	const ids = new Set<string>();
	for (const item of data) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const id = (item as { id?: unknown }).id;
		if (typeof id === 'string' && id.trim().length > 0) {
			ids.add(id.trim());
		}
	}

	return [...ids].sort((a, b) => a.localeCompare(b)).map((id) => ({ name: id, value: id }));
}

/**
 * Build OpenAI-compatible chat messages from a simple prompt and optional system text.
 */
export function buildChatMessages(input: { prompt: string; systemMessage?: string }): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const systemMessage = input.systemMessage?.trim() ?? '';
	if (systemMessage.length > 0) {
		messages.push({ role: 'system', content: systemMessage });
	}

	const prompt = input.prompt.trim();
	if (prompt.length === 0) {
		throw new Error('Prompt is required for a chat completion');
	}
	messages.push({ role: 'user', content: prompt });
	return messages;
}

/**
 * Extract assistant text from a chat.completions response.
 */
export function extractCompletionText(response: unknown): string {
	if (!response || typeof response !== 'object') {
		return '';
	}
	const choices = (response as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return '';
	}
	const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
	return typeof message?.content === 'string' ? message.content : '';
}
