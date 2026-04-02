#!/usr/bin/env node

const DEFAULT_POLL_MS = 2500;
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const DEFAULT_CHAT_URL = 'https://chatgpt.com/';
const INTERACTIVE_SELECTOR = 'button, [role="button"], a, div[role="button"]';
const CONTINUE_PATTERNS = [
	/continue generating/i,
	/continue response/i,
	/^continue$/i,
	/^resume$/i,
	/^retry$/i,
	/try again/i,
	/^approve$/i,
	/^allow$/i,
	/always allow/i,
	/^confirm$/i,
	/grant access/i,
	/grant permission/i,
	/\uACC4\uC18D \uC0DD\uC131/,
	/\uC751\uB2F5 \uACC4\uC18D/,
	/^\uACC4\uC18D$/,
	/^\uACC4\uC18D\uD558\uAE30$/,
	/^\uC7AC\uAC1C$/,
	/^\uB2E4\uC2DC \uC2DC\uB3C4$/,
	/^\uB2E4\uC2DC \uC0DD\uC131$/,
	/^\uC2B9\uC778$/,
	/^\uD5C8\uC6A9$/,
	/\uD56D\uC0C1 \uD5C8\uC6A9/,
	/^\uD655\uC778$/,
	/\uC561\uC138\uC2A4\s*(\uAD8C\uD55C\s*)?\uBD80\uC5EC(?!\uB428)/,
	/\uAD8C\uD55C\s*\uD5C8\uC6A9/,
	/\uC811\uADFC\s*\uD5C8\uC6A9/,
];
const PERMISSION_PROMPT_PATTERNS = [
	/^approve$/i,
	/^allow$/i,
	/always allow/i,
	/^confirm$/i,
	/grant access/i,
	/grant permission/i,
	/allow access/i,
	/allow permission/i,
	/authorize/i,
	/permission/i,
	/approve request/i,
	/confirm access/i,
	/confirm permission/i,
	/^\uC2B9\uC778$/,
	/^\uD5C8\uC6A9$/,
	/\uD56D\uC0C1 \uD5C8\uC6A9/,
	/^\uD655\uC778$/,
	/\uC561\uC138\uC2A4\s*(\uAD8C\uD55C\s*)?\uBD80\uC5EC(?!\uB428)/,
	/\uAD8C\uD55C\s*\uD5C8\uC6A9/,
	/\uC811\uADFC\s*\uD5C8\uC6A9/,
	/\uC694\uCCAD\s*\uC2B9\uC778/,
];
const CONTINUE_EXCLUDE_PATTERNS = [
	/\uBD80\uC5EC\uB428/,
	/granted/i,
	/\uC694\uCCAD \uC644\uB8CC/,
	/request complete/i,
	/\uB3C4\uAD6C \uC694\uCCAD \uC644\uB8CC/,
	/completed/i,
	/\bthought\b/i,
	/thinking/i,
	/\uC798 \uC0DD\uAC01\uD558\uAE30/,
	/\uD655\uC7A5 \uCD94\uB860/,
	/\uC2A4\uD2B8\uB9AC\uBC0D \uC911\uC9C0/,
	/stop streaming/i,
];
const STREAMING_PATTERNS = [/stop streaming/i, /\uC2A4\uD2B8\uB9AC\uBC0D \uC911\uC9C0/, /generating/i, /\uC0DD\uC131 \uC911/];

function sanitizeToken(value) {
	if (typeof value !== 'string') {
		return '';
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return '';
	}
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('`') && trimmed.endsWith('`'))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function readArgs(argv) {
	const options = {
		appOrigin: process.env.OPEN_GPT_APP_ORIGIN || '',
		queueToken: sanitizeToken(process.env.QUEUE_API_TOKEN || ''),
		bearerToken: sanitizeToken(process.env.OPEN_GPT_BEARER_TOKEN || ''),
		cdpUrl: process.env.OPEN_GPT_CDP_URL || DEFAULT_CDP_URL,
		pollMs: Number(process.env.OPEN_GPT_POLL_MS || DEFAULT_POLL_MS),
		matchUrl: process.env.OPEN_GPT_MATCH_URL || 'chatgpt.com',
		agentName: process.env.OPEN_GPT_BROWSER_AGENT_NAME || 'local-chatgpt-companion',
		openUrl: process.env.OPEN_GPT_CHAT_URL || DEFAULT_CHAT_URL,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key.startsWith('--')) continue;
		if (value == null) break;
		switch (key) {
			case '--app-origin':
				options.appOrigin = value;
				index += 1;
				break;
			case '--queue-token':
				options.queueToken = sanitizeToken(value);
				index += 1;
				break;
			case '--bearer-token':
				options.bearerToken = sanitizeToken(value);
				index += 1;
				break;
			case '--cdp-url':
				options.cdpUrl = value;
				index += 1;
				break;
			case '--poll-ms':
				options.pollMs = Number(value);
				index += 1;
				break;
			case '--match-url':
				options.matchUrl = value;
				index += 1;
				break;
			case '--agent-name':
				options.agentName = value;
				index += 1;
				break;
			case '--open-url':
				options.openUrl = value;
				index += 1;
				break;
			default:
				break;
		}
	}
	return options;
}

function usage() {
	console.log(`Usage:
  node worker/scripts/run-chatgpt-browser-companion.mjs \\
    --app-origin https://opengpt-github-mcp-worker.iusung111.workers.dev \\
    --queue-token <queue-token> \\
    --cdp-url http://127.0.0.1:9222

Auth:
  Provide either --queue-token or --bearer-token.

Browser:
  Launch Chrome/Edge with remote debugging enabled before starting the companion.
  Example (Windows):
    chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\\opengpt-chatgpt-profile
`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadPlaywright() {
	try {
		return await import('playwright');
	} catch (playwrightError) {
		try {
			return await import('playwright-core');
		} catch {
			const message = playwrightError instanceof Error ? playwrightError.message : String(playwrightError);
			throw new Error(`Playwright is required for the browser companion. Install it with "npm install -D playwright". Original error: ${message}`);
		}
	}
}

function buildHeaders(options) {
	const headers = { accept: 'application/json' };
	if (options.queueToken) {
		headers['x-queue-token'] = options.queueToken;
	}
	if (!options.queueToken && options.bearerToken) {
		headers.authorization = `Bearer ${options.bearerToken}`;
	}
	return headers;
}

async function apiRequest(options, path, requestOptions = {}) {
	const headers = {
		...buildHeaders(options),
		...(requestOptions.headers || {}),
	};
	if (requestOptions.body != null && !headers['content-type']) {
		headers['content-type'] = 'application/json';
	}
	const response = await fetch(`${options.appOrigin}${path}`, {
		method: requestOptions.method || 'GET',
		headers,
		body: requestOptions.body != null ? JSON.stringify(requestOptions.body) : undefined,
	});
	const payload = await response.json().catch(async () => ({ ok: false, error: await response.text() }));
	if (!response.ok || payload.ok === false) {
		const message = payload && typeof payload.error === 'string' ? payload.error : `${response.status} ${response.statusText}`.trim();
		throw new Error(message);
	}
	return payload;
}

function collectPages(browser) {
	return browser.contexts().flatMap((context) => context.pages().map((page) => ({ context, page })));
}

async function choosePage(browser, options, command = null) {
	const pages = collectPages(browser);
	const matchUrl = command?.page_url_hint || options.matchUrl || 'chatgpt.com';
	let chosen = pages.find(({ page }) => page.url().includes(matchUrl));
	if (!chosen && pages.length) {
		chosen = pages[0];
	}
	if (!chosen) {
		const context = browser.contexts()[0];
		if (!context) {
			throw new Error('No browser context is available through the CDP connection.');
		}
		const page = await context.newPage();
		await page.goto(command?.page_url_hint || options.openUrl || DEFAULT_CHAT_URL, {
			waitUntil: 'domcontentloaded',
			timeout: 15000,
		});
		return page;
	}
	if (!chosen.page.url() || chosen.page.url() === 'about:blank') {
		await chosen.page.goto(command?.page_url_hint || options.openUrl || DEFAULT_CHAT_URL, {
			waitUntil: 'domcontentloaded',
			timeout: 15000,
		});
	}
	return chosen.page;
}

async function firstVisibleLocator(page, selectors) {
	for (const selector of selectors) {
		const locator = page.locator(selector).first();
		try {
			if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1000 }).catch(() => false))) {
				return locator;
			}
		} catch {}
	}
	return null;
}

function normalizeCandidateText(value) {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function testPattern(pattern, value) {
	const expression = new RegExp(pattern.source, pattern.flags);
	return expression.test(value);
}

function candidatePriority(candidate) {
	let score = 0;
	if (candidate.inDialog) score += 40;
	if (candidate.inForm) score += 30;
	if (candidate.inMain) score += 20;
	if (candidate.tag === 'button') score += 10;
	if (!candidate.inNav) score += 5;
	if (candidate.testid) score += 2;
	return score;
}

async function collectInteractiveCandidates(page) {
	const locator = page.locator(INTERACTIVE_SELECTOR);
	const total = Math.min(await locator.count(), 250);
	const candidates = [];
	for (let index = 0; index < total; index += 1) {
		const candidate = locator.nth(index);
		try {
			if (!(await candidate.isVisible({ timeout: 500 }).catch(() => false))) {
				continue;
			}
			const meta = await candidate.evaluate((element) => {
				const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
				const aria = element.getAttribute('aria-label') || '';
				const title = element.getAttribute('title') || '';
				const testid = element.getAttribute('data-testid') || '';
				const name = element.getAttribute('name') || '';
				const label = aria || text || title || testid || name || element.tagName.toLowerCase();
				return {
					tag: element.tagName.toLowerCase(),
					text,
					aria,
					title,
					testid,
					name,
					label,
					fields: [aria, text, title, testid, name].filter(Boolean),
					searchText: [aria, text, title, testid, name].filter(Boolean).join(' ').toLowerCase(),
					disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
					inDialog: Boolean(element.closest('[role="dialog"], dialog')),
					inMain: Boolean(element.closest('main')),
					inForm: Boolean(element.closest('form')),
					inNav: Boolean(element.closest('nav, aside')),
				};
			});
			candidates.push({
				...meta,
				index,
				locator: candidate,
				label: normalizeCandidateText(meta.label),
				fields: Array.isArray(meta.fields) ? meta.fields.map((value) => normalizeCandidateText(value.toLowerCase())) : [],
				searchText: normalizeCandidateText(meta.searchText),
			});
		} catch {}
	}
	return candidates.sort((left, right) => candidatePriority(right) - candidatePriority(left));
}

async function visibleActionSummary(page, limit = 8) {
	const candidates = await collectInteractiveCandidates(page);
	return candidates
		.filter((candidate) => !candidate.disabled)
		.slice(0, limit)
		.map((candidate) => {
			const suffix = [candidate.testid, candidate.aria].filter(Boolean).slice(0, 1).join(' | ');
			return suffix ? `${candidate.label} [${suffix}]` : candidate.label;
		});
}

async function clickByPatterns(page, patterns, options = {}) {
	const excludePatterns = Array.isArray(options.excludePatterns) ? options.excludePatterns : [];
	const candidates = await collectInteractiveCandidates(page);
	for (const pattern of patterns) {
		for (const candidate of candidates) {
			if (candidate.disabled || !candidate.searchText) {
				continue;
			}
			if (
				excludePatterns.some(
					(entry) => testPattern(entry, candidate.searchText) || candidate.fields.some((field) => testPattern(entry, field)),
				)
			) {
				continue;
			}
			if (!testPattern(pattern, candidate.searchText) && !candidate.fields.some((field) => testPattern(pattern, field))) {
				continue;
			}
			try {
				await candidate.locator.click({ timeout: 3000 });
				return candidate.label || pattern.toString();
			} catch {}
		}
	}
	return null;
}

async function chatGptBusy(page) {
	const candidates = await collectInteractiveCandidates(page);
	return candidates.some(
		(candidate) =>
			!candidate.disabled &&
			STREAMING_PATTERNS.some((pattern) => testPattern(pattern, candidate.searchText) || candidate.fields.some((field) => testPattern(pattern, field))),
	);
}

async function runClickContinue(page) {
	const matched = [];
	const deadline = Date.now() + 20000;
	for (let attempts = 0; attempts < 3; attempts += 1) {
		const label = await clickByPatterns(page, CONTINUE_PATTERNS, { excludePatterns: CONTINUE_EXCLUDE_PATTERNS });
		if (!label) break;
		matched.push(label);
		await page.waitForTimeout(900);
	}
	if (!matched.length) {
		while (Date.now() < deadline && (await chatGptBusy(page))) {
			await page.waitForTimeout(1500);
			const label = await clickByPatterns(page, CONTINUE_PATTERNS, { excludePatterns: CONTINUE_EXCLUDE_PATTERNS });
			if (!label) {
				continue;
			}
			matched.push(label);
			await page.waitForTimeout(900);
			break;
		}
	}
	if (!matched.length) {
		const visibleActions = await visibleActionSummary(page);
		const detail = visibleActions.length ? ` Visible actions: ${visibleActions.join(' | ')}.` : '';
		throw new Error(`No visible continue/approve/resume button was found on the target ChatGPT page.${detail}`);
	}
	return matched;
}

async function runResolvePermissionPrompt(page) {
	const matched = [];
	const deadline = Date.now() + 20000;
	for (let attempts = 0; attempts < 3; attempts += 1) {
		const label = await clickByPatterns(page, PERMISSION_PROMPT_PATTERNS, { excludePatterns: CONTINUE_EXCLUDE_PATTERNS });
		if (!label) break;
		matched.push(label);
		await page.waitForTimeout(900);
	}
	if (!matched.length) {
		while (Date.now() < deadline && (await chatGptBusy(page))) {
			await page.waitForTimeout(1500);
			const label = await clickByPatterns(page, PERMISSION_PROMPT_PATTERNS, { excludePatterns: CONTINUE_EXCLUDE_PATTERNS });
			if (!label) {
				continue;
			}
			matched.push(label);
			await page.waitForTimeout(900);
			break;
		}
	}
	if (!matched.length) {
		const visibleActions = await visibleActionSummary(page);
		const detail = visibleActions.length ? ` Visible actions: ${visibleActions.join(' | ')}.` : '';
		throw new Error(`No visible approval or permission button was found on the target ChatGPT page.${detail}`);
	}
	return matched;
}

async function fillPrompt(page, prompt) {
	const composer = await firstVisibleLocator(page, [
		'#prompt-textarea',
		'textarea',
		'div[contenteditable="true"]',
	]);
	if (!composer) {
		throw new Error('No visible ChatGPT composer was found.');
	}
	await composer.click({ timeout: 3000 });
	try {
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	} catch {}
	const tagName = await composer.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
	if (tagName === 'textarea' || tagName === 'input') {
		await composer.fill(prompt, { timeout: 5000 });
	} else {
		await page.keyboard.insertText(prompt);
	}
	const sendLabel = await clickByPatterns(page, [
		/^send$/i,
		/send message/i,
		/submit/i,
		/\uBCF4\uB0B4\uAE30/,
		/\uBA54\uC2DC\uC9C0 \uBCF4\uB0B4\uAE30/,
		/\uC804\uC1A1/,
	]);
	if (!sendLabel) {
		await page.keyboard.press('Enter');
		return ['Send'];
	}
	return [sendLabel];
}

async function executeCommand(page, command) {
	const matchedActions = [];
	if (command.kind === 'click_continue') {
		matchedActions.push(...(await runClickContinue(page)));
		return {
			ok: true,
			summary: `Clicked ${matchedActions.join(', ')}.`,
			matchedActions,
		};
	}
	if (command.kind === 'resolve_permission_prompt') {
		matchedActions.push(...(await runResolvePermissionPrompt(page)));
		return {
			ok: true,
			summary: `Approved the visible permission prompt via ${matchedActions.join(', ')}.`,
			matchedActions,
		};
	}
	if (command.kind === 'send_prompt') {
		if (!command.prompt || !command.prompt.trim()) {
			throw new Error('send_prompt requires a non-empty prompt.');
		}
		matchedActions.push(...(await fillPrompt(page, command.prompt)));
		return {
			ok: true,
			summary: 'Sent the queued prompt into the current ChatGPT conversation.',
			matchedActions,
		};
	}
	if (command.kind === 'auto_continue_run') {
		try {
			matchedActions.push(...(await runClickContinue(page)));
		} catch {}
		if (command.prompt && command.prompt.trim()) {
			matchedActions.push(...(await fillPrompt(page, command.prompt)));
		}
		if (!matchedActions.length) {
			throw new Error('No continue action or prompt send action could be executed.');
		}
		return {
			ok: true,
			summary: 'Completed the queued auto-continue action in ChatGPT.',
			matchedActions,
		};
	}
	throw new Error(`Unsupported command kind: ${String(command.kind)}`);
}

async function pageMetadata(page) {
	return {
		page_url: page.url() || null,
		page_title: (await page.title().catch(() => '')) || null,
	};
}

async function main() {
	const options = readArgs(process.argv.slice(2));
	if (!options.appOrigin || (!options.queueToken && !options.bearerToken)) {
		usage();
		process.exitCode = 1;
		return;
	}

	const { chromium } = await loadPlaywright();
	const sessionId = crypto.randomUUID();
	let stopping = false;
	let browser = null;

	const stop = async () => {
		stopping = true;
		try {
			await apiRequest(options, '/gui/api/browser-control/session/disconnect', {
				method: 'POST',
			});
		} catch (error) {
			console.warn(`[browser-companion] disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			if (browser) {
				await browser.close();
			}
		} catch {}
	};

	process.on('SIGINT', () => {
		void stop().finally(() => process.exit(0));
	});
	process.on('SIGTERM', () => {
		void stop().finally(() => process.exit(0));
	});

	browser = await chromium.connectOverCDP(options.cdpUrl);
	console.log(`[browser-companion] connected to ${options.cdpUrl}`);

	while (!stopping) {
		let page = null;
		let command = null;
		try {
			page = await choosePage(browser, options, null);
			const meta = page ? await pageMetadata(page) : { page_url: null, page_title: null };
			await apiRequest(options, '/gui/api/browser-control/session', {
				method: 'POST',
				body: {
					session_id: sessionId,
					agent_name: options.agentName,
					page_url: meta.page_url,
					page_title: meta.page_title,
					browser_name: 'chromium-cdp',
					cdp_origin: options.cdpUrl,
				},
			});

			const nextPayload = await apiRequest(options, `/gui/api/browser-control/commands/next?session_id=${encodeURIComponent(sessionId)}`);
			command = nextPayload?.data?.command;
			if (!command || typeof command.command_id !== 'string') {
				await sleep(options.pollMs);
				continue;
			}

			page = await choosePage(browser, options, command);
			const result = await executeCommand(page, command);
			const finalMeta = await pageMetadata(page);
			await apiRequest(
				options,
				`/gui/api/browser-control/commands/${encodeURIComponent(command.command_id)}/complete`,
				{
					method: 'POST',
					body: {
						ok: result.ok,
						summary: result.summary,
						error: null,
						matched_actions: result.matchedActions,
						page_url: finalMeta.page_url,
						page_title: finalMeta.page_title,
					},
				},
			);
			console.log(
				`[browser-companion] completed ${command.kind}${command.job_id ? ` for ${command.job_id}` : ''}: ${result.summary}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[browser-companion] ${message}`);
			if (command && typeof command.command_id === 'string') {
				try {
					const currentPage = page ?? (await choosePage(browser, options, command));
					const meta = currentPage ? await pageMetadata(currentPage) : { page_url: null, page_title: null };
					await apiRequest(
						options,
						`/gui/api/browser-control/commands/${encodeURIComponent(command.command_id)}/complete`,
						{
							method: 'POST',
							body: {
								ok: false,
								summary: null,
								error: message,
								matched_actions: [],
								page_url: meta.page_url,
								page_title: meta.page_title,
							},
						},
					).catch(() => {});
				} catch {}
			}
			await sleep(options.pollMs);
		}
	}
}

await main();
