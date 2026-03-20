import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const AUTH_FAILURE_PATTERN = /Invalid access token|Authentication error|Max auth failures reached/i;

function parseArgs(argv) {
	const options = {
		secretName: '',
		secretValue: '',
		targetArgs: [],
		maxAttempts: 5,
		initialDelaySeconds: 10,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--secret-name') options.secretName = argv[++index] ?? '';
		else if (arg === '--secret-value') options.secretValue = argv[++index] ?? '';
		else if (arg === '--target-arg') options.targetArgs.push(argv[++index] ?? '');
		else if (arg === '--max-attempts') options.maxAttempts = Number(argv[++index] ?? '5');
		else if (arg === '--initial-delay-seconds') options.initialDelaySeconds = Number(argv[++index] ?? '10');
	}

	if (!options.secretName) throw new Error('missing --secret-name');
	return options;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWrangler(secretName, filePath, targetArgs) {
	return new Promise((resolve) => {
		const child = spawn(
			'npx',
			['wrangler', 'secret', 'put', secretName, ...targetArgs],
			{
				shell: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: process.env,
			},
		);
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
		child.stdin.end();
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options.secretValue) {
		console.log(`Skipping ${options.secretName} because no value was provided.`);
		return;
	}

	const tempDir = await mkdtemp(join(tmpdir(), 'cf-secret-'));
	const secretFile = join(tempDir, `${options.secretName}.txt`);
	await writeFile(secretFile, options.secretValue, 'utf8');

	try {
		let delaySeconds = options.initialDelaySeconds;
		for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
			const result = await runWrangler(options.secretName, secretFile, options.targetArgs);
			if (result.code === 0) {
				return;
			}
			if (AUTH_FAILURE_PATTERN.test(result.output)) {
				throw new Error(`Cloudflare authentication failed for ${options.secretName}`);
			}
			if (attempt === options.maxAttempts) {
				throw new Error(`wrangler secret put failed for ${options.secretName}`);
			}
			console.log(
				`wrangler secret put failed for ${options.secretName}; retrying in ${delaySeconds}s (attempt ${attempt}/${options.maxAttempts})`,
			);
			await sleep(delaySeconds * 1000);
			delaySeconds *= 2;
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

await main();
