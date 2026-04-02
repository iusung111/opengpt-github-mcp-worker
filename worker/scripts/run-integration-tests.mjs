import { spawnSync } from 'node:child_process';
import { buildLocalWorkerdEnv } from './local-workerd-paths.mjs';

const vitestArgs = [
	'vitest',
	'run',
	'worker/test/runtime-http',
	'worker/test/runtime-mcp',
	'worker/test/queue-webhook.spec.ts',
	'--sequence.concurrent=false',
];

const result = spawnSync('npx', vitestArgs, {
	env: buildLocalWorkerdEnv(),
	stdio: 'inherit',
	shell: true,
});

if (typeof result.status === 'number') {
	process.exit(result.status);
}

process.exit(1);
