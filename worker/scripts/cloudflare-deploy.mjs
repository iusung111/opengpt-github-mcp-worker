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

	for (let attempt = 1; attempt <= 6; attempt += 1) {
		const result = await runCommand('curl', ['--silent', '--show-error', '--fail', `${deployUrl}/healthz`]);
		if (result.code === 0) {
			const payload = JSON.parse(result.output);
			if (payload.ok && payload.auth_configured) {
				console.log('Health check passed with auth_configured=true');
				return;
			}
			console.log(JSON.stringify(payload));
		}
		if (attempt < 6) {
			console.log(`Attempt ${attempt}: Health check failed. Retrying in 5s...`);
			await sleep(5000);
		}
	}

	throw new Error('Health check timed out or auth_configured=false. Deployment might be broken.');
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	await deployWithRetry(options);
	await healthCheck(options.deployUrl);
}

await main();
