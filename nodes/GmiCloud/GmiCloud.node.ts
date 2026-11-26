import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	DEFAULT_BASE_URL,
	buildChatMessages,
	extractCompletionText,
	normalizeBaseUrl,
	parseModelOptions,
} from '../shared/gmiCloud';

type CompletionOptions = {
	temperature?: number;
	maxTokens?: number;
	topP?: number;
};

export class GmiCloud implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GMI Cloud',
		name: 'gmiCloud',
		icon: { light: 'file:../../icons/gmicloud.svg', dark: 'file:../../icons/gmicloud.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"]}}',
		description: 'Create chat completions and list models on GMI Cloud',
		defaults: {
			name: 'GMI Cloud',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
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
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Chat Completion',
						value: 'chatCompletion',
						action: 'Create a chat completion',
						description: 'Send a prompt to a GMI Cloud model and return the completion',
					},
					{
						name: 'List Models',
						value: 'listModels',
						action: 'List models',
						description: 'List models available to this API key',
					},
				],
				default: 'chatCompletion',
			},
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				required: true,
				default: '',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
					},
				},
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				required: true,
				default: '',
				typeOptions: {
					rows: 4,
				},
				description: 'The user message to send to the model',
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
					},
				},
			},
			{
				displayName: 'System Message',
				name: 'systemMessage',
				type: 'string',
				default: '',
				typeOptions: {
					rows: 2,
				},
				description: 'Optional system instruction prepended to the conversation',
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
					},
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options to add',
				type: 'collection',
				default: {},
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
					},
				},
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

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const credentials = await this.getCredentials('gmiCloudApi');
				const baseURL = normalizeBaseUrl(credentials.baseUrl);

				if (operation === 'listModels') {
					const response = await this.helpers.httpRequestWithAuthentication.call(this, 'gmiCloudApi', {
						method: 'GET',
						baseURL,
						url: '/models',
						json: true,
					});
					returnData.push({
						json: {
							models: parseModelOptions(response).map((model) => model.value),
							data: (response as { data?: unknown }).data ?? [],
						},
						pairedItem: { item: i },
					});
					continue;
				}

				if (operation !== 'chatCompletion') {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
						itemIndex: i,
					});
				}

				const model = this.getNodeParameter('model', i) as string;
				const prompt = this.getNodeParameter('prompt', i, '') as string;
				const systemMessage = this.getNodeParameter('systemMessage', i, '') as string;
				const options = this.getNodeParameter('options', i, {}) as CompletionOptions;

				let messages;
				try {
					messages = buildChatMessages({ prompt, systemMessage });
				} catch (error) {
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				}

				const body: Record<string, unknown> = {
					model,
					messages,
				};
				if (options.temperature !== undefined) {
					body.temperature = options.temperature;
				}
				if (options.maxTokens !== undefined) {
					body.max_tokens = options.maxTokens;
				}
				if (options.topP !== undefined) {
					body.top_p = options.topP;
				}

				const response = await this.helpers.httpRequestWithAuthentication.call(this, 'gmiCloudApi', {
					method: 'POST',
					baseURL,
					url: '/chat/completions',
					body,
					json: true,
				});

				returnData.push({
					json: {
						text: extractCompletionText(response),
						...(typeof response === 'object' && response !== null
							? (response as Record<string, unknown>)
							: { raw: response }),
					},
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: (error as Error).message,
						},
						pairedItem: { item: i },
					});
					continue;
				}

				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				}

				throw new NodeApiError(this.getNode(), error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
