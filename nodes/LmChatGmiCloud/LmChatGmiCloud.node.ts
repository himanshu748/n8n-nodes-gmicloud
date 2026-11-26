import { supplyModel } from '@n8n/ai-node-sdk';
import type { ILoadOptionsFunctions, INodeType, INodeTypeDescription, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeApiError } from 'n8n-workflow';

import { DEFAULT_BASE_URL, normalizeBaseUrl, parseModelOptions } from '../shared/gmiCloud';

type ModelOptions = {
	temperature?: number;
	maxTokens?: number;
	topP?: number;
};

export class LmChatGmiCloud implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GMI Cloud Chat Model',
		name: 'lmChatGmiCloud',
		icon: { light: 'file:../../icons/gmicloud.svg', dark: 'file:../../icons/gmicloud.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["model"]}}',
		description: 'Chat model for GMI Cloud, for use with AI Agent and chain nodes',
		defaults: {
			name: 'GMI Cloud Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'gmiCloudApi',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: `={{$credentials.baseUrl || "${DEFAULT_BASE_URL}"}}`,
		},
		properties: [
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				required: true,
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options to add',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Maximum Tokens',
						name: 'maxTokens',
						default: 1024,
						typeOptions: { minValue: 1 },
						description: 'The maximum number of tokens to generate in the completion',
						type: 'number',
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						default: 0.7,
						typeOptions: { maxValue: 2, minValue: 0, numberPrecision: 1 },
						description:
							'Controls randomness: lowering results in less random completions. As the temperature approaches zero, the model becomes more deterministic.',
						type: 'number',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						default: 1,
						typeOptions: { maxValue: 1, minValue: 0, numberPrecision: 1 },
						description:
							'An alternative to sampling with temperature, called nucleus sampling. The model considers tokens with top_p probability mass.',
						type: 'number',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions) {
				try {
					const credentials = await this.getCredentials('gmiCloudApi');
					const response = await this.helpers.httpRequestWithAuthentication.call(this, 'gmiCloudApi', {
						method: 'GET',
						baseURL: normalizeBaseUrl(credentials.baseUrl),
						url: '/models',
						json: true,
					});
					return parseModelOptions(response);
				} catch (error) {
					throw new NodeApiError(this.getNode(), error);
				}
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
		const credentials = await this.getCredentials('gmiCloudApi');
		const modelName = this.getNodeParameter('model', itemIndex) as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as ModelOptions;

		return supplyModel(this, {
			type: 'openai',
			baseUrl: normalizeBaseUrl(credentials.baseUrl),
			apiKey: credentials.apiKey as string,
			model: modelName,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
			topP: options.topP,
		});
	}
}
