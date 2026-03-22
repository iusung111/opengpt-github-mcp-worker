import { spawn } from 'node:child_process';

const AUTH_FAILURE_PATTERN = /Invalid access token|Authentication error|Max auth failures reached/i;

function parseArgs(argv) {
	const options = {
		deployTarget: 'live',
		deployUrl: '',
		maxAttempts: 5,
		initialDelaySeconds: 10,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--deploy-target') options.deployTarget = argv[++index] ?? 'live';
		else if (arg === '--deploy-url') options.deployUrl = argv[++index] ?? '';
		else if (arg === '--max-attempts') options.maxAttempts = Number(argv[++index] ?? '5');
		else if (arg === '--initial-delay-seconds') options.initialDelaySeconds = Number(argv[++index] ?? '10');
	}
	return options;
}

function getMcpVarOverrides() {
	const overrides = [];
	for (const key of [
		'SELF_CURRENT_URL',
		'SELF_DEPLOY_ENV',
		'SELF_RELEASE_COMMIT_SHA',
		'MIRROR_GITHUB_APP_ID',
		'MIRROR_GITHUB_APP_INSTALLATION_ID',
		'MCP_ALLOWED_EMAILS',
		'MCP_ALLOWED_EMAIL_DOMAINS',
		'CHATGPT_MCP_AUTH_MODE',
		'CHATGPT_MCP_ISSUER',
		'CHATGPT_MCP_AUDIENCE',
		'CHATGPT_MCP_JWKS_URL',
		'CHATGPT_MCP_JWKS_JSON',
		'CHATGPT_MCP_ALLOWED_EMAILS',
	]) {
		const value = process.env[key];
		if (value !== undefined) {
			overrides.push('--var', `${key}:${value}`);
		}
	}
	return overrides;
}

function getSelfVarOverrides(options) {
	const overrides = [];
	const normalizedDeployUrl = (options.deployUrl ?? '').trim().replace(/\/$/, '');
	const deployEnvironment = options.deployTarget === 'mirror' ? 'mirror' : 'live';
	const releaseCommitSha = (process.env.EXPECTED_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '').trim();
	if (normalizedDeployUrl) {
		overrides.push('--var', `SELF_CURRENT_URL:${normalizedDeployUrl}`);
	}
	overrides.push('--var', `SELF_DEPLOY_ENV:${deployEnvironment}`);
	if (releaseCommitSha) {
		overrides.push('--var', `SELF_RELEASE_COMMIT_SHA:${releaseCommitSha}`);
	}
	return overrides;
}

function getExpectedMcpAccessMode() {
	if ((process.env.MCP_REQUIRE_ACCESS_AUTH ?? '').trim().toLowerCase() === 'false') {
		return 'disabled';
	}
	if (process.env.MCP_REQUIRE_ACCESS_AUTH === undefined) {
		return null;
	}
	const hasAllowedEmails = (process.env.MCP_ALLOWED_EMAILS ?? '').trim().length > 0;
	const hasAllowedDomains = (process.env.MCP_ALLOWED_EMAIL_DOMAINS ?? '').trim().length > 0;
	return hasAllowedEmails || hasAllowedDomains ? 'email_or_domain_allowlist' : 'any_authenticated_user';
}

function getExpectedChatgptMcpMode() {
	if (process.env.CHATGPT_MCP_AUTH_MODE === undefined) {
		return null;
	}
	if ((process.env.CHATGPT_MCP_AUTH_MODE ?? '').trim().toLowerCase() !== 'oidc') {
		return 'disabled';
	}
	return (process.env.CHATGPT_MCP_ALLOWED_EMAILS ?? '').trim().length > 0
		? 'oidc_email_allowlist'
		: 'oidc_deny_all';
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			shell: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
		});
		let output = '';
		child.stdout.on('data', (chunk) => {
			const text = chunk.toString();
			output += text;
			process.stdout.write(text);
		});
		child.stderr.on('data', (chunk) => {
			const text = chunk.toString();
			output += text;
			process.stderr.write(text);
		});
		child.on('close', (code) => resolve({ code: code ?? 1, output }));
	});
}

async function deployWithRetry(options) {
	const args = ['wrangler', 'deploy'];
	if (options.deployTarget === 'mirror') args.push('--env', 'mirror');
	args.push(...getSelfVarOverrides(options));
	args.push(...getMcpVarOverrides());

	let delaySeconds = options.initialDelaySeconds;
	for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
		const result = await runCommand('npx', args);
		if (result.code === 0) {
			return;
		}
		if (AUTH_FAILURE_PATTERN.test(result.output)) {
			throw new Error(`Cloudflare authentication failed during ${options.deployTarget} deploy`);
		}
		if (attempt === options.maxAttempts) {
			throw new Error(`wrangler deploy failed for ${options.deployTarget}`);
		}
		console.log(
			`wrangler deploy failed for ${options.deployTarget}; retrying in ${delaySeconds}s (attempt ${attempt}/${options.maxAttempts})`,
		);
		await sleep(delaySeconds * 1000);
		delaySeconds *= 2;
	}
}

async function healthCheck(deployUrl) {
	if (!deployUrl) throw new Error('missing --deploy-url');
	const expectedMcpAccessMode = getExpectedMcpAccessMode();
	const expectedChatgptMcpMode = getExpectedChatgptMcpMode();
	const expectedDeployEnvironment = (process.env.SELF_DEPLOY_ENV ?? '').trim().toLowerCase() || null;
	const expectedReleaseCommitSha = (process.env.EXPECTED_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '').trim() || null;

	for (let attempt = 1; attempt <= 6; attempt += 1) {
		const result = await runCommand('curl', ['--silent', '--show-error', '--fail', `${deployUrl}/healthz`]);
		if (result.code === 0) {
			const payload = JSON.parse(result.output);
			if (
				payload.ok &&
				payload.auth_configured &&
				(expectedMcpAccessMode === null || payload.mcp_access_mode === expectedMcpAccessMode) &&
				(expectedChatgptMcpMode === null || payload.chatgpt_mcp_auth_mode === expectedChatgptMcpMode) &&
				(!expectedDeployEnvironment || payload.deploy_environment === expectedDeployEnvironment) &&
				(!expectedReleaseCommitSha || payload.release_commit_sha === expectedReleaseCommitSha)
			) {
				console.log(
					`Health check passed with auth_configured=true, mcp_access_mode=${expectedMcpAccessMode}, chatgpt_mcp_auth_mode=${expectedChatgptMcpMode}, deploy_environment=${payload.deploy_environment}, release_commit_sha=${payload.release_commit_sha ?? 'null'}`,
				);
				return;
			}
			console.log(JSON.stringify(payload));
		}
		if (attempt < 6) {
			console.log(`Attempt ${attempt}: Health check failed. Retrying in 5s...`);
			await sleep(5000);
		}
	}

	throw new Error(
		`Health check timed out or did not reach expected MCP modes (${expectedMcpAccessMode ?? 'skip'}, ${expectedChatgptMcpMode ?? 'skip'}) and deploy identity (${expectedDeployEnvironment ?? 'n/a'}, ${expectedReleaseCommitSha ?? 'n/a'}).`,
	);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	await deployWithRetry(options);
	await healthCheck(options.deployUrl);
}

await main();
