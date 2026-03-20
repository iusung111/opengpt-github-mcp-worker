import { spawnSync } from 'node:child_process';

const vitestArgs = [
	'vitest',
	'run',
	'test/index.spec.ts',
	'test/queue-webhook.spec.ts',
	'--sequence.concurrent=false',
];

if (process.platform === 'win32') {
	console.log(
		[
			'Skipping DO runtime integration tests on Windows.',
			'Miniflare/workerd SQLite-backed Durable Object tests are not stable on this host.',
			'Run `npm run test:integration:runtime` on Linux or CI for full coverage.',
		].join('\n'),
	);
	process.exit(0);
}

const result = spawnSync('npx', vitestArgs, {
	stdio: 'inherit',
	shell: true,
});

if (typeof result.status === 'number') {
	process.exit(result.status);
}

process.exit(1);
