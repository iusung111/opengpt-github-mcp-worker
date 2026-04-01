import * as z from 'zod/v4';

export type RepoIdentityInput = {
	repo_key?: string;
	owner?: string;
	repo?: string;
};

export type ResolvedRepoIdentity = {
	repo_key: string;
	owner: string;
	repo: string;
};

export const repoIdentityInputSchema = {
	repo_key: z.string().optional(),
	owner: z.string().optional(),
	repo: z.string().optional(),
};

function parseRepoKey(repoKey: string): ResolvedRepoIdentity {
	const trimmed = repoKey.trim();
	const segments = trimmed.split('/').map((segment) => segment.trim()).filter(Boolean);
	if (segments.length !== 2) {
		throw new Error(
			`invalid repo identity: repo_key must use owner/repo form, received ${repoKey}.`,
		);
	}
	const [owner, repo] = segments;
	return {
		repo_key: `${owner}/${repo}`,
		owner,
		repo,
	};
}

export function resolveRepoIdentityInput(input: RepoIdentityInput): ResolvedRepoIdentity {
	const repoKey = input.repo_key?.trim();
	const owner = input.owner?.trim();
	const repo = input.repo?.trim();

	if (repoKey) {
		const resolved = parseRepoKey(repoKey);
		if ((owner && owner !== resolved.owner) || (repo && repo !== resolved.repo)) {
			throw new Error(
				`invalid repo identity: repo_key ${resolved.repo_key} does not match owner/repo ${owner ?? ''}/${repo ?? ''}.`,
			);
		}
		return resolved;
	}

	if (owner && repo) {
		return {
			repo_key: `${owner}/${repo}`,
			owner,
			repo,
		};
	}

	throw new Error(
		'invalid repo identity: provide repo_key in owner/repo form or provide both owner and repo.',
	);
}

export function withRepoIdentity<T extends RepoIdentityInput, TResult>(
	handler: (input: T & ResolvedRepoIdentity) => Promise<TResult> | TResult,
): (input: T) => Promise<TResult> | TResult {
	return (input: T) => handler({ ...input, ...resolveRepoIdentityInput(input) } as T & ResolvedRepoIdentity);
}
