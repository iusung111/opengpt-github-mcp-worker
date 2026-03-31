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

export function ensureSafePath(path: string): void {
	if (path.includes('..') || path.startsWith('/') || path.startsWith('\\')) {
		throw new Error(`unsafe path: ${path}`);
	}
}

export function ensureWorkflowAllowed(env: AppEnv, repoKey: string, workflowId: string): void {
	const allowed = getAllowedWorkflowsForRepo(env, repoKey);
	if (!allowed.includes(workflowId)) {
		diagnosticLog('workflow_not_allowlisted', { repo_key: repoKey, workflow_id: workflowId, allowed_count: allowed.length });
		throw new Error(`workflow not allowlisted for ${repoKey}: ${workflowId}`);
	}
}
