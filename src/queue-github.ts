import { AppEnv } from './types';
import { githubGet } from './utils';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findLatestWorkflowRunId(
	env: AppEnv,
	owner: string,
	repo: string,
	workflowId: string,
	ref: string,
	dispatchedAtIso: string,
	maxAttempts = 5,
	delayMs = 1000,
): Promise<
	| {
			id: number;
			created_at?: string;
			head_branch?: string;
			name?: string;
			status?: string;
			conclusion?: string;
			html_url?: string;
	  }
	| undefined
> {
	const dispatchedAt = Date.parse(dispatchedAtIso);
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const data = (await githubGet(
			env,
			`/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs`,
			{ params: { branch: ref, event: 'workflow_dispatch', per_page: 10 } },
		)) as {
			workflow_runs?: Array<{
				id?: number;
				created_at?: string;
				head_branch?: string;
				name?: string;
				status?: string;
				conclusion?: string;
				html_url?: string;
			}>;
		};
		const run = (data.workflow_runs ?? []).find((item) => {
			if (!item.id || !item.created_at) {
				return false;
			}
			return Date.parse(item.created_at) >= dispatchedAt - 15_000;
		});
		if (run?.id) {
			return {
				id: run.id,
				created_at: run.created_at,
				head_branch: run.head_branch,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				html_url: run.html_url,
			};
		}
		if (delayMs > 0) {
			await sleep(delayMs);
		}
	}
	return undefined;
}
