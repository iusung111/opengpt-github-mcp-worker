export const PROJECT_REPO_OWNER = 'iusung111';
export const PROJECT_REPO_NAME = 'Project_OpenGPT';
export const PROJECT_REPO_KEY = `${PROJECT_REPO_OWNER}/${PROJECT_REPO_NAME}`;

export const LEGACY_PROJECT_REPO_NAME = 'OpenGPT';
export const LEGACY_PROJECT_REPO_KEY = `${PROJECT_REPO_OWNER}/${LEGACY_PROJECT_REPO_NAME}`;

function normalizeRepoSegment(value: string): string {
	return value.trim();
}

function isLegacyProjectRepo(owner: string, repo: string): boolean {
	return owner.trim().toLowerCase() === PROJECT_REPO_OWNER.toLowerCase() && repo.trim().toLowerCase() === LEGACY_PROJECT_REPO_NAME.toLowerCase();
}

function isCanonicalProjectRepo(owner: string, repo: string): boolean {
	return owner.trim().toLowerCase() === PROJECT_REPO_OWNER.toLowerCase() && repo.trim().toLowerCase() === PROJECT_REPO_NAME.toLowerCase();
}

export function canonicalizeRepoName(owner: string, repo: string): string {
	if (isLegacyProjectRepo(owner, repo) || isCanonicalProjectRepo(owner, repo)) {
		return PROJECT_REPO_NAME;
	}
	return normalizeRepoSegment(repo);
}

export function canonicalizeRepoKey(repoKey: string): string {
	const trimmed = String(repoKey ?? '').trim();
	const segments = trimmed.split('/').map(normalizeRepoSegment).filter(Boolean);
	if (segments.length !== 2) {
		return trimmed;
	}
	const [owner, repo] = segments;
	if (isLegacyProjectRepo(owner, repo) || isCanonicalProjectRepo(owner, repo)) {
		return PROJECT_REPO_KEY;
	}
	return `${owner}/${repo}`;
}

export function canonicalizeWorkspaceDisplayName(value: string): string {
	const trimmed = String(value ?? '').trim();
	if (!trimmed) {
		return trimmed;
	}
	if (trimmed === LEGACY_PROJECT_REPO_NAME || trimmed === PROJECT_REPO_NAME) {
		return PROJECT_REPO_NAME;
	}
	if (trimmed === LEGACY_PROJECT_REPO_KEY || trimmed === PROJECT_REPO_KEY) {
		return PROJECT_REPO_KEY;
	}
	return trimmed;
}

export function canonicalizeWorkspacePath(value: string): string {
	const trimmed = String(value ?? '').trim();
	if (!trimmed) {
		return trimmed;
	}
	return trimmed
		.replace(/([\\/])projects([\\/])OpenGPT(?=([\\/]|$))/g, `$1projects$2${PROJECT_REPO_NAME}`)
		.replace(/([\\/])repos([\\/])sandbox([\\/])OpenGPT(?=([\\/]|$))/g, `$1repos$2sandbox$3${PROJECT_REPO_NAME}`);
}
