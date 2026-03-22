import { spawnSync } from 'node:child_process';
import { buildLocalWorkerdEnv } from './local-workerd-paths.mjs';

const result = spawnSync('npx', ['wrangler', 'types', 'worker/types/worker-configuration.d.ts'], {
	env: buildLocalWorkerdEnv(),
	stdio: 'inherit',
	shell: true,
});

if (typeof result.status === 'number') {
	process.exit(result.status);
}

process.exit(1);
