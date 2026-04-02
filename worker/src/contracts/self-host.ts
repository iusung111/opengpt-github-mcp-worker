export interface SelfHostHealthSnapshot {
	url: string | null;
	healthz: Record<string, unknown> | null;
}

export interface SelfHostRecentDeployRun {
	id: number | null;
	name: string | null;
	status: string | null;
	conclusion: string | null;
	html_url: string | null;
	created_at: string | null;
	head_branch: string | null;
	event: string | null;
}

export interface SelfHostStatusSnapshot {
	self_repo_key: string;
	github: {
		html_url: string | null;
		default_branch: string | null;
		pushed_at: string | null;
		open_issues_count: number | null;
	};
	workspace: Record<string, unknown> | null;
	live: SelfHostHealthSnapshot;
	mirror: SelfHostHealthSnapshot;
	deploy_strategy: {
		default_target: 'mirror' | 'live';
		require_mirror_for_live: boolean;
		mirror_distinct_from_live: boolean;
	};
	current_deploy: {
		environment: 'mirror' | 'live' | 'unknown';
		current_url: string | null;
		release_commit_sha: string | null;
	};
	workflow_allowlist: {
		global: string[];
		self_repo: string[];
		by_repo: Record<string, string[]>;
	};
	read_observability: Record<string, unknown>;
	self_deploy_workflow: string;
	recent_self_deploy_runs: SelfHostRecentDeployRun[];
	warnings: string[];
}
