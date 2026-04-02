import { AppEnv } from '../contracts';
import { decodeBase64Text, encodeGitHubPath, githubGet } from '../utils';

export async function readRepoTextFile(
	env: AppEnv,
	owner: string,
	repo: string,
	path: string,
	ref: string,
): Promise<string> {
	const payload = (await githubGet(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
		params: { ref },
	})) as { content?: string; type?: string };
	if (payload.type && payload.type !== 'file') {
		throw new Error(`path is not a file: ${path}`);
	}
	const text = decodeBase64Text(payload.content);
	if (text === null) {
		throw new Error(`unable to decode file content: ${path}`);
	}
	return text;
}

export async function readRepoTree(
	env: AppEnv,
	owner: string,
	repo: string,
	ref: string,
): Promise<Array<Record<string, unknown>>> {
	const result = (await githubGet(env, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`, {
		params: { recursive: true },
	})) as { tree?: Array<Record<string, unknown>> };
	return result.tree ?? [];
}

export function findContractCandidates(
	tree: Array<Record<string, unknown>>,
	configuredSources: string[],
): Array<Record<string, unknown>> {
	const normalizedSources = configuredSources.map((source) => source.trim()).filter(Boolean);
	const matches = tree.filter((entry) => {
		const entryPath = String(entry.path ?? '');
		if (!entryPath) {
			return false;
		}
		if (normalizedSources.length === 0) {
			return /(openapi|swagger|api)[^/]*\.(json|ya?ml)$/i.test(entryPath);
		}
		return normalizedSources.some((source) => entryPath === source || entryPath.startsWith(`${source}/`));
	});
	return matches.map((entry) => ({
		path: entry.path ?? null,
		type: entry.type ?? null,
		sha: entry.sha ?? null,
	}));
}

