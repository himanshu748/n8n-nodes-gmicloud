import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_BASE_URL,
	buildChatMessages,
	extractCompletionText,
	normalizeBaseUrl,
	parseModelOptions,
} from '../nodes/shared/gmiCloud.ts';

describe('normalizeBaseUrl', () => {
	it('defaults to the public /v1 endpoint', () => {
		assert.equal(normalizeBaseUrl(undefined), DEFAULT_BASE_URL);
		assert.equal(normalizeBaseUrl(''), DEFAULT_BASE_URL);
		assert.equal(normalizeBaseUrl('   '), DEFAULT_BASE_URL);
	});

	it('strips trailing slashes', () => {
		assert.equal(normalizeBaseUrl('https://api.gmi-serving.com/v1/'), DEFAULT_BASE_URL);
		assert.equal(normalizeBaseUrl('https://api.gmi-serving.com/v1///'), DEFAULT_BASE_URL);
	});

	it('keeps a custom dedicated endpoint', () => {
		assert.equal(
			normalizeBaseUrl('https://api-prod1.gmi-ie.com/v1'),
			'https://api-prod1.gmi-ie.com/v1',
		);
	});
});

describe('parseModelOptions', () => {
	it('extracts, deduplicates and sorts model ids', () => {
		const options = parseModelOptions({
			object: 'list',
			data: [
				{ id: 'zai-org/GLM-5.3-Flash', object: 'model' },
				{ id: 'deepseek-ai/DeepSeek-V4-Flash' },
				{ id: 'zai-org/GLM-5.3-Flash' },
				{ id: '  ' },
				{ object: 'model' },
				null,
			],
		});
		assert.deepEqual(
			options.map((item) => item.value),
			['deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-5.3-Flash'],
		);
		assert.equal(options[0].name, options[0].value);
	});

	it('returns an empty list for unexpected payloads', () => {
		assert.deepEqual(parseModelOptions(null), []);
		assert.deepEqual(parseModelOptions({}), []);
		assert.deepEqual(parseModelOptions({ data: 'nope' }), []);
	});
});

describe('buildChatMessages', () => {
	it('builds a user message and optional system message', () => {
		assert.deepEqual(buildChatMessages({ prompt: 'Hello' }), [{ role: 'user', content: 'Hello' }]);
		assert.deepEqual(buildChatMessages({ prompt: 'Hello', systemMessage: 'Be brief' }), [
			{ role: 'system', content: 'Be brief' },
			{ role: 'user', content: 'Hello' },
		]);
	});

	it('rejects an empty prompt', () => {
		assert.throws(() => buildChatMessages({ prompt: '   ' }), /Prompt is required/);
	});
});

describe('extractCompletionText', () => {
	it('reads the first choice message content', () => {
		assert.equal(
			extractCompletionText({
				choices: [{ message: { role: 'assistant', content: 'Hi there' } }],
			}),
			'Hi there',
		);
		assert.equal(extractCompletionText({ choices: [] }), '');
		assert.equal(extractCompletionText(null), '');
	});
});
