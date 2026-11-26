#!/usr/bin/env node
/**
 * End-to-end test: live GMI API (tiny spend) + a local n8n instance
 * with this community package loaded. Never prints secrets.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const USER_FOLDER = path.join(ROOT, '.n8n-e2e');
const RESULTS = path.join(ROOT, 'test-results');
const SCREENSHOTS = path.join(ROOT, 'docs/screenshots');
const PORT = Number(process.env.N8N_PORT || 5678);
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_BASE_URL = 'https://api.gmi-serving.com/v1';
const PREFERRED_MODELS = [
	'google/gemini-3.5-flash-lite',
	'google/gemma-4-26b-a4b-it',
	'Qwen/Qwen3.8-Flash',
	'XiaomiMiMo/MiMo-V2.6-Flash',
	'zai-org/GLM-5.3-Flash',
];

const OWNER = {
	email: 'gmi-e2e@localhost.local',
	firstName: 'Gmi',
	lastName: 'E2e',
	password: 'GmiCloud-E2E-Test-1',
};

function redact(value) {
	const key = process.env.GMI_API_KEY || '';
	let text = String(value);
	if (key.length > 0) {
		text = text.split(key).join('[REDACTED_GMI_API_KEY]');
	}
	text = text.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]');
	return text;
}

function log(message) {
	console.log(redact(message));
}

function fail(message) {
	console.error(`ERROR: ${redact(message)}`);
	process.exitCode = 1;
	throw new Error(message);
}

async function gmiRequest(pathname, { method = 'GET', body } = {}) {
	const key = process.env.GMI_API_KEY;
	if (!key) fail('GMI_API_KEY is not set');
	const url = `${DEFAULT_BASE_URL}${pathname}`;
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${key}`,
			'Content-Type': 'application/json',
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		fail(`GMI ${method} ${pathname} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
	}
	if (!response.ok) {
		fail(`GMI ${method} ${pathname} failed (${response.status}): ${JSON.stringify(json).slice(0, 400)}`);
	}
	return json;
}

async function smokeGmiApi() {
	log('1. Live GMI API smoke test (list models + tiny completion)');
	const models = await gmiRequest('/models');
	const ids = (models.data || []).map((item) => item.id).filter(Boolean);
	if (ids.length === 0) fail('GET /v1/models returned no model ids');
	log(`   GET /v1/models: ${ids.length} models`);

	const candidates = [
		...PREFERRED_MODELS.filter((id) => ids.includes(id)),
		...ids.filter((id) => /flash-lite|gemma/i.test(id)),
		...ids.filter((id) => /flash/i.test(id)),
		ids[0],
	].filter((id, index, all) => id && all.indexOf(id) === index);

	let model;
	let completion;
	let text = '';
	let usage = {};
	for (const candidate of candidates.slice(0, 4)) {
		model = candidate;
		log(`   Trying model: ${model}`);
		completion = await gmiRequest('/chat/completions', {
			method: 'POST',
			body: {
				model,
				temperature: 0,
				max_tokens: 16,
				messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
			},
		});
		text = completion?.choices?.[0]?.message?.content ?? '';
		usage = completion?.usage ?? {};
		log(
			`   POST /v1/chat/completions: text=${JSON.stringify(text).slice(0, 80)} usage=${JSON.stringify(usage)}`,
		);
		if (String(text).trim()) break;
		log('   Empty content (likely reasoning-only); trying another model');
	}
	if (!String(text).trim()) fail('Chat completion returned no text');
	return { model, modelCount: ids.length, completionText: text, usage };
}

function cookieJar() {
	const cookies = new Map();
	return {
		store(response) {
			const raw = response.headers.getSetCookie?.() ?? [];
			for (const header of raw) {
				const pair = header.split(';', 1)[0];
				const eq = pair.indexOf('=');
				if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
			}
		},
		header() {
			return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
		},
		get(name) {
			return cookies.get(name);
		},
	};
}

async function n8nFetch(jar, pathname, { method = 'GET', body, headers = {} } = {}) {
	const response = await fetch(`${BASE}${pathname}`, {
		method,
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			...(jar.header() ? { Cookie: jar.header() } : {}),
			...headers,
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	jar.store(response);
	const text = await response.text();
	let json = text;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text.slice(0, 500) };
	}
	return { response, json };
}

async function waitForN8n(n8n, timeoutMs = 240_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const output = n8n.getOutput();
		const editorReady = /Editor is now accessible via/i.test(output);
		if (editorReady) {
			try {
				const response = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
				if (response.ok || response.status === 204) return;
			} catch {
				// health endpoint may lag the ready log by a moment
			}
			return;
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	fail(`n8n did not become ready on ${BASE} within ${timeoutMs}ms`);
}

function startN8n() {
	const env = {
		...process.env,
		N8N_USER_FOLDER: USER_FOLDER,
		N8N_PORT: String(PORT),
		N8N_LISTEN_ADDRESS: '127.0.0.1',
		N8N_ENCRYPTION_KEY: 'e2e-n8n-gmi-cloud-encryption-key',
		N8N_DIAGNOSTICS_ENABLED: 'false',
		N8N_PERSONALIZATION_ENABLED: 'false',
		N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
		N8N_HIRING_BANNER_DISABLED: 'true',
		N8N_COMMUNITY_PACKAGES_ENABLED: 'true',
		N8N_DEV_RELOAD: 'false',
		DB_SQLITE_POOL_SIZE: '10',
		N8N_LOG_LEVEL: 'info',
		// Prevent the process from opening a browser
		N8N_SECURE_COOKIE: 'false',
		N8N_RUNNERS_BROKER_PORT: process.env.N8N_RUNNERS_BROKER_PORT || '5679',
	};
	// Do not leak the GMI key into n8n logs via env display; it is only needed
	// when we create the credential through the API.
	const n8nBin = process.env.N8N_BIN || 'npx';
	const args = process.env.N8N_BIN ? [] : ['-y', 'n8n@2.49.7'];
	const child = spawn(n8nBin, args, {
		cwd: USER_FOLDER,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
	});
	let output = '';
	const onData = (chunk) => {
		const text = redact(chunk.toString());
		output += text;
		for (const line of text.split(/\r?\n/)) {
			if (line.trim()) log(`   [n8n] ${line}`);
		}
	};
	child.stdout.on('data', onData);
	child.stderr.on('data', onData);
	child.on('exit', (code, signal) => {
		if (code && code !== 0) {
			log(`n8n exited with code ${code} signal ${signal}`);
		}
	});
	return { child, getOutput: () => output };
}

async function setupN8n(jar, smoke) {
	log('3. Setting up n8n owner, credential and workflow');
	const setup = await n8nFetch(jar, '/rest/owner/setup', {
		method: 'POST',
		body: OWNER,
	});
	if (!setup.response.ok && setup.response.status !== 400) {
		fail(`Owner setup failed (${setup.response.status}): ${JSON.stringify(setup.json)}`);
	}

	const login = await n8nFetch(jar, '/rest/login', {
		method: 'POST',
		body: { emailOrLdapLoginId: OWNER.email, email: OWNER.email, password: OWNER.password },
	});
	if (!login.response.ok) {
		fail(`Login failed (${login.response.status}): ${JSON.stringify(login.json)}`);
	}
	log('   Logged in');

	const types = await n8nFetch(jar, '/types/nodes.json');
	const credTypes = await n8nFetch(jar, '/types/credentials.json');
	const typeList = Array.isArray(types.json)
		? types.json
		: Array.isArray(types.json?.data)
			? types.json.data
			: [];
	const typeNames = typeList.map((t) => t.name).filter(Boolean);
	const credentialTypeNames = (Array.isArray(credTypes.json)
		? credTypes.json
		: Array.isArray(credTypes.json?.data)
			? credTypes.json.data
			: []
	)
		.map((t) => t.name)
		.filter(Boolean);
	const loaded = typeNames.filter((name) => /gmiCloud|gmicloud|GMI/i.test(name));
	log(`   Loaded GMI node types: ${loaded.join(', ') || '(none found)'} (from ${typeNames.length} types, HTTP ${types.response.status})`);
	log(
		`   Credential types mentioning GMI: ${credentialTypeNames.filter((n) => /gmi/i.test(n)).join(', ') || '(none)'}`,
	);
	const regularType =
		loaded.find((name) => name.endsWith('.gmiCloud') || name === 'gmiCloud') || loaded.find((name) => /gmiCloud$/i.test(name) && !/lmChat/i.test(name));
	const chatModelType = loaded.find((name) => /lmChatGmiCloud/i.test(name));
	if (!regularType) {
		const sample = typeNames.filter((n) => /custom|n8n-nodes-/i.test(n)).slice(0, 30);
		fail(
			`GMI Cloud nodes were not loaded. Sample: ${sample.join(', ') || JSON.stringify(types.json).slice(0, 300)}`,
		);
	}
	if (!credentialTypeNames.includes('gmiCloudApi')) {
		fail(`GMI Cloud credential type was not loaded. Found: ${credentialTypeNames.filter((n) => /gmi|custom/i.test(n)).join(', ')}`);
	}

	const cred = await n8nFetch(jar, '/rest/credentials', {
		method: 'POST',
		body: {
			name: 'GMI Cloud e2e',
			type: 'gmiCloudApi',
			data: {
				apiKey: process.env.GMI_API_KEY,
				baseUrl: DEFAULT_BASE_URL,
			},
		},
	});
	if (!cred.response.ok) {
		fail(`Create credential failed (${cred.response.status}): ${JSON.stringify(cred.json)}`);
	}
	const credentialId = cred.json?.id || cred.json?.data?.id;
	if (!credentialId) fail(`No credential id in response: ${JSON.stringify(cred.json)}`);
	log(`   Created credential ${credentialId}`);

	const workflow = {
		name: 'GMI Cloud e2e',
		nodes: [
			{
				parameters: {},
				id: 'start',
				name: 'Start',
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [0, 0],
			},
			{
				parameters: {
					operation: 'listModels',
				},
				id: 'list',
				name: 'List Models',
				type: regularType,
				typeVersion: 1,
				position: [260, 0],
				credentials: {
					gmiCloudApi: { id: credentialId, name: 'GMI Cloud e2e' },
				},
			},
			{
				parameters: {
					operation: 'chatCompletion',
					model: smoke.model,
					prompt: 'Reply with the single word pong.',
					options: { temperature: 0, maxTokens: 16 },
				},
				id: 'chat',
				name: 'Chat Completion',
				type: regularType,
				typeVersion: 1,
				position: [520, 0],
				credentials: {
					gmiCloudApi: { id: credentialId, name: 'GMI Cloud e2e' },
				},
			},
		],
		connections: {
			Start: { main: [[{ node: 'List Models', type: 'main', index: 0 }]] },
			'List Models': { main: [[{ node: 'Chat Completion', type: 'main', index: 0 }]] },
		},
		settings: { executionOrder: 'v1' },
	};

	const created = await n8nFetch(jar, '/rest/workflows', {
		method: 'POST',
		body: workflow,
	});
	if (!created.response.ok) {
		fail(`Create workflow failed (${created.response.status}): ${JSON.stringify(created.json)}`);
	}
	const workflowId = created.json?.id || created.json?.data?.id;
	const workflowPayload = created.json?.data || created.json;
	log(`   Created workflow ${workflowId}`);
	return { credentialId, workflowId, workflowPayload, regularType, chatModelType };
}

async function runWorkflow(jar, workflowId, workflowPayload) {
	log('4. Executing the workflow in n8n');
	const attempts = [
		{
			path: `/rest/workflows/${workflowId}/run`,
			body: { triggerToStartFrom: { name: 'Start' } },
		},
		{
			path: `/rest/workflows/${workflowId}/run`,
			body: { destinationNode: { nodeName: 'Chat Completion', mode: 'inclusive' } },
		},
	];
	let last;
	for (const attempt of attempts) {
		const result = await n8nFetch(jar, attempt.path, { method: 'POST', body: attempt.body });
		last = result;
		if (result.response.ok) {
			log(`   Run started via ${attempt.path}`);
			return result.json;
		}
		log(`   ${attempt.path} -> ${result.response.status}`);
	}
	fail(`Could not run workflow: ${JSON.stringify(last?.json)}`);
}

async function waitForExecution(jar, runJson, timeoutMs = 120_000) {
	const executionId =
		runJson?.id ||
		runJson?.data?.id ||
		runJson?.executionId ||
		runJson?.data?.executionId ||
		runJson?.data?.execution?.id;
	if (!executionId) {
		// Some n8n versions return the finished execution immediately
		if (runJson?.data?.resultData || runJson?.finished || runJson?.status) {
			return runJson.data || runJson;
		}
		fail(`No execution id in run response: ${JSON.stringify(runJson).slice(0, 500)}`);
	}
	log(`   Execution id ${executionId}`);
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const result = await n8nFetch(jar, `/rest/executions/${executionId}`);
		const data = result.json?.data || result.json;
		const status = data?.status || data?.finished;
		if (data?.finished || status === 'success' || status === 'error' || status === 'crashed') {
			return data;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	fail(`Execution ${executionId} did not finish in ${timeoutMs}ms`);
}

function parseFlatted(value) {
	if (!value) return value;
	if (typeof value === 'object' && !Array.isArray(value)) return value;
	const parsed = typeof value === 'string' ? JSON.parse(value) : value;
	if (!Array.isArray(parsed)) return parsed;
	const resolve = (item, seen = new Set()) => {
		if (typeof item === 'string' && /^\d+$/.test(item)) {
			const idx = Number(item);
			if (idx >= 0 && idx < parsed.length && !seen.has(idx)) {
				seen.add(idx);
				return resolve(parsed[idx], seen);
			}
		}
		if (Array.isArray(item)) return item.map((entry) => resolve(entry, seen));
		if (item && typeof item === 'object') {
			return Object.fromEntries(
				Object.entries(item).map(([key, entry]) => [key, resolve(entry, seen)]),
			);
		}
		return item;
	};
	return resolve(parsed[0]);
}

function summariseExecution(execution) {
	const unflattened = parseFlatted(execution?.data);
	const resultData = unflattened?.resultData || execution?.resultData || unflattened || execution;
	const runData = resultData?.runData || {};
	const summary = {};
	for (const [name, runs] of Object.entries(runData)) {
		const last = Array.isArray(runs) ? runs.at(-1) : runs;
		const items = last?.data?.main?.[0] ?? [];
		const json = items[0]?.json;
		summary[name] = {
			status: last?.executionStatus || last?.status || execution?.status,
			error: last?.error?.message || resultData?.error?.message,
			preview: json
				? {
						modelCount: Array.isArray(json.models) ? json.models.length : undefined,
						text: json.text,
						id: json.id,
					}
				: undefined,
		};
	}
	return summary;
}

async function takeScreenshots(jar, workflowId) {
	log('5. Capturing screenshots');
	let chromium;
	try {
		({ chromium } = await import('playwright-core'));
	} catch {
		log('   playwright-core not installed; skipping screenshots');
		return [];
	}

	const browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
		headless: true,
		args: ['--no-sandbox', '--disable-dev-shm-usage'],
	});
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const cookieHeader = jar.header();
	if (cookieHeader) {
		const cookies = cookieHeader.split('; ').map((pair) => {
			const eq = pair.indexOf('=');
			return {
				name: pair.slice(0, eq),
				value: pair.slice(eq + 1),
				url: BASE,
			};
		});
		await context.addCookies(cookies);
	}
	const page = await context.newPage();
	const files = [];

	async function snap(name, url) {
		await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
		await page.waitForTimeout(1500);
		const dest = path.join(SCREENSHOTS, name);
		await page.screenshot({ path: dest, fullPage: true });
		files.push(dest);
		log(`   Wrote ${dest}`);
	}

	try {
		await snap('n8n-editor.png', `${BASE}/workflow/${workflowId}`);
		const plusButtons = [
			page.locator('[data-test-id="node-creator-plus-button"]'),
			page.locator('[data-test-id="add-node-button"]'),
			page.getByRole('button', { name: /^plus$/i }),
			page.locator('button:has-text("+")').last(),
		];
		for (const button of plusButtons) {
			if (await button.first().isVisible().catch(() => false)) {
				await button.first().click();
				break;
			}
		}
		await page.waitForTimeout(500);
		const search = page.locator(
			'[data-test-id="node-creator-search-bar"], input[placeholder*="Search" i]',
		).first();
		if (await search.isVisible().catch(() => false)) {
			await search.fill('GMI Cloud');
			await page.waitForTimeout(1200);
			await page.screenshot({
				path: path.join(SCREENSHOTS, 'n8n-node-panel-gmi-cloud.png'),
				fullPage: true,
			});
			files.push(path.join(SCREENSHOTS, 'n8n-node-panel-gmi-cloud.png'));
			log(`   Wrote ${path.join(SCREENSHOTS, 'n8n-node-panel-gmi-cloud.png')}`);
		}
		await snap('n8n-executions.png', `${BASE}/workflow/${workflowId}/executions`);
	} catch (error) {
		log(`   Screenshot warning: ${error.message}`);
	} finally {
		await browser.close();
	}
	return files;
}

async function main() {
	if (!process.env.GMI_API_KEY) fail('GMI_API_KEY is not set');
	await mkdir(RESULTS, { recursive: true });
	await mkdir(SCREENSHOTS, { recursive: true });

	const smoke = await smokeGmiApi();

	log('2. Starting local n8n with n8n-nodes-gmicloud loaded');
	const { symlink: makeSymlink, access } = await import('node:fs/promises');
	const readyMarker = path.join(USER_FOLDER, '.n8n', '.e2e-ready');
	let alreadyReady = false;
	if (process.env.E2E_RESET === '1') {
		await rm(USER_FOLDER, { recursive: true, force: true });
	} else {
		const dbCandidates = [
			path.join(USER_FOLDER, '.n8n', 'database.sqlite'),
			path.join(USER_FOLDER, '.n8n', 'database.sqlite.lock'),
		];
		try {
			await access(readyMarker);
			alreadyReady = true;
		} catch {
			try {
				await access(path.join(USER_FOLDER, '.n8n', 'database.sqlite'));
				alreadyReady = true;
			} catch {
				await rm(USER_FOLDER, { recursive: true, force: true });
			}
		}
	}
	const customRoot = path.join(USER_FOLDER, '.n8n', 'custom');
	const symlink = path.join(customRoot, 'node_modules', 'n8n-nodes-gmicloud');
	await mkdir(path.dirname(symlink), { recursive: true });
	await writeFile(
		path.join(customRoot, 'package.json'),
		JSON.stringify({ name: 'n8n-custom-nodes', private: true }, null, 2),
	);
	try {
		await rm(symlink, { force: true });
	} catch {
		// ignore
	}
	await makeSymlink(ROOT, symlink, 'dir');
	if (alreadyReady) log('   Reusing existing n8n user folder');

	const n8n = startN8n();
	let screenshots = [];
	let executionSummary;
	try {
		await waitForN8n(n8n);
		await writeFile(path.join(USER_FOLDER, '.n8n', '.e2e-ready'), 'ok');
		log('   n8n is up');
		const jar = cookieJar();
		const created = await setupN8n(jar, smoke);
		const runJson = await runWorkflow(jar, created.workflowId, created.workflowPayload);
		const execution = await waitForExecution(jar, runJson);
		executionSummary = summariseExecution(execution);
		log(`   Execution status: ${execution.status || execution.finished}`);
		log(`   Execution summary: ${JSON.stringify(executionSummary)}`);
		if (execution.status && execution.status !== 'success') {
			fail(`Workflow execution status was ${execution.status}`);
		}
		const list = executionSummary['List Models'];
		const chat = executionSummary['Chat Completion'];
		if (!list?.preview?.modelCount) {
			fail(`List Models did not return models: ${JSON.stringify(executionSummary)}`);
		}
		if (!String(chat?.preview?.text || '').trim()) {
			fail(`Chat Completion did not return text: ${JSON.stringify(executionSummary)}`);
		}
		screenshots = await takeScreenshots(jar, created.workflowId);

		const report = {
			ok: true,
			smoke: {
				model: smoke.model,
				modelCount: smoke.modelCount,
				completionText: smoke.completionText,
				usage: smoke.usage,
			},
			execution: executionSummary,
			screenshots,
			n8n: BASE,
		};
		const reportPath = path.join(RESULTS, 'e2e-report.json');
		await writeFile(reportPath, redact(JSON.stringify(report, null, 2)));
		log(`E2E passed. Report: ${reportPath}`);
	} finally {
		const pid = n8n.child.pid;
		try {
			if (pid) process.kill(-pid, 'SIGTERM');
		} catch {
			n8n.child.kill('SIGTERM');
		}
		await new Promise((r) => setTimeout(r, 2000));
		try {
			if (pid) process.kill(-pid, 'SIGKILL');
		} catch {
			// already exited
		}
	}
}

main().catch((error) => {
	console.error(`E2E failed: ${redact(error.stack || error.message)}`);
	process.exit(1);
});
