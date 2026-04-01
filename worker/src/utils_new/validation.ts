import { AppEnv } from '../types';
import { diagnosticLog } from './common';
import {
	getAllowedRepos,
	getAllowedWorkflowsForRepo,
	getBranchPrefix,
	getDefaultBaseBranch,
} from './env';

export function repoAllowed(env: AppEnv, repo: string): boolean {
	const allowed = getAllowedRepos(env);
	return allowed.length === 0 || allowed.includes(repo);
}

export function ensureRepoAllowed(env: AppEnv, repo: string): void {
	if (!repoAllowed(env, repo)) {
		throw new Error(`repository not allowlisted: ${repo}`);
	}
}

export function ensureBranchAllowed(env: AppEnv, branch: string): void {
	const prefix = getBranchPrefix(env);
	if (!branch.startsWith(prefix)) {
		throw new Error(`branch must start with ${prefix}: ${branch}`);
	}
}

export function ensureNotDefaultBranch(env: AppEnv, branch: string): void {
	const defaultBranch = getDefaultBaseBranch(env);
	if (branch === defaultBranch) {
		throw new Error(`direct write to ${defaultBranch} branch is forbidden`);
	}
}

export function ensureSafeRepoPath(path: string): string {
	const normalized = String(path ?? '').trim();
	if (!normalized) {
		throw new Error(
			'invalid repo path: path is empty. Repo file paths must be repository-relative POSIX paths like worker/src/index.ts, not local filesystem paths.',
		);
	}
	if (normalized.startsWith('/') || normalized.startsWith('\\') || /^[A-Za-z]:/.test(normalized)) {
		throw new Error(
			`invalid repo path: ${path}. Repo file paths must be repository-relative POSIX paths like worker/src/index.ts, not local filesystem paths.`,
		);
	}
	if (normalized.includes('\\')) {
		throw new Error(
			`invalid repo path: ${path}. Repo file paths must use forward slashes and stay repository-relative, for example worker/src/index.ts.`,
		);
	}
	const segments = normalized.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(
			`invalid repo path: ${path}. Repo file paths must be repository-relative POSIX paths like worker/src/index.ts, without traversal segments.`,
		);
	}
	return normalized;
}

export function ensureWorkflowAllowed(env: AppEnv, repoKey: string, workflowId: string): void {
	const allowed = getAllowedWorkflowsForRepo(env, repoKey);
	if (!allowed.includes(workflowId)) {
		diagnosticLog('workflow_not_allowlisted', { repo_key: repoKey, workflow_id: workflowId, allowed_count: allowed.length });
		throw new Error(`workflow not allowlisted for ${repoKey}: ${workflowId}`);
	}
}

export function validateWorkflowInputs(inputs: Record<string, unknown>): void {
	if (typeof inputs.instructions_b64 === 'string') {
		try {
			JSON.parse(atob(inputs.instructions_b64));
		} catch {
			throw new Error('instructions_b64 must decode to valid JSON');
		}
	}
}
