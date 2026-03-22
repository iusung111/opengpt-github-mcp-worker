import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function ensureDir(targetPath) {
	mkdirSync(targetPath, { recursive: true });
	return targetPath;
}

export function configureLocalWorkerdPaths() {
	const runtimeRoot = ensureDir(path.join(repoRoot, '.wrangler', 'state', 'local-workerd'));
	const tmpRoot = ensureDir(path.join(runtimeRoot, 'tmp'));
	const miniflareRoot = ensureDir(path.join(runtimeRoot, 'miniflare'));
	const durableObjectsPersist = ensureDir(path.join(miniflareRoot, 'durable-objects'));

	process.env.TMPDIR = tmpRoot;
	process.env.TMP = tmpRoot;
	process.env.TEMP = tmpRoot;

	return {
		repoRoot,
		runtimeRoot,
		tmpRoot,
		miniflareRoot,
		durableObjectsPersist,
	};
}

export function buildLocalWorkerdEnv(baseEnv = process.env) {
	const { tmpRoot } = configureLocalWorkerdPaths();
	return {
		...baseEnv,
		TMPDIR: tmpRoot,
		TMP: tmpRoot,
		TEMP: tmpRoot,
	};
}
