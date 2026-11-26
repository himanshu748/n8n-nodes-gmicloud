import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

import { DEFAULT_BASE_URL } from '../nodes/shared/gmiCloud';

export class GmiCloudApi implements ICredentialType {
	name = 'gmiCloudApi';

	displayName = 'GMI Cloud API';

	documentationUrl =
		'https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference';

	icon: Icon = { light: 'file:../icons/gmicloud.svg', dark: 'file:../icons/gmicloud.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'API key from the GMI Cloud console (console.gmicloud.ai). Sent as a Bearer token.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: DEFAULT_BASE_URL,
			placeholder: DEFAULT_BASE_URL,
			description:
				'OpenAI-compatible API base, including the /v1 prefix. Change this only if GMI gives you a dedicated endpoint.',
		},
	];

	// Hits GET {baseUrl}/models, i.e. GET /v1/models on the default endpoint.
	test: ICredentialTestRequest = {
		request: {
			baseURL: `={{$credentials.baseUrl || "${DEFAULT_BASE_URL}"}}`,
			url: '/models',
			method: 'GET',
		},
	};

	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		requestOptions.headers ??= {};
		requestOptions.headers.Authorization = `Bearer ${credentials.apiKey as string}`;
		return requestOptions;
	}
}
