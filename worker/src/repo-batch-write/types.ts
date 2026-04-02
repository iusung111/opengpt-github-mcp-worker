export type RepoBatchWriteMode = 'preview' | 'apply';

export interface RepoBatchWriteOperation {
	type: 'create_file' | 'update_file' | 'delete_file' | 'rename_path' | 'mkdir_scaffold';
	path?: string;
	from_path?: string;
	to_path?: string;
	message?: string;
	content_b64?: string;
	expected_blob_sha?: string;
	entries?: Array<{ path: string; content_b64?: string }>;
}

export interface RepoPatchsetInput {
	path: string;
	expected_blob_sha?: string;
	patch_unified: string;
}

export interface RepoFileTreeEntry {
	path: string;
	sha: string | null;
	mode: string | null;
	type: string | null;
}

export interface RepoFileSnapshot extends RepoFileTreeEntry {
	exists: boolean;
	content_b64: string | null;
	content_text: string | null;
}

export interface PreparedTreeChange {
	path: string;
	action: 'create' | 'update' | 'delete' | 'rename' | 'mkdir_scaffold';
	mode: string;
	type: 'blob';
	sha?: string | null;
	content_b64?: string;
	previous_path?: string | null;
	previous_blob_sha?: string | null;
}

export interface GitRefResponse {
	object?: { sha?: string };
}

export interface GitCommitResponse {
	tree?: { sha?: string };
}

export interface TreeResponse {
	tree?: Array<{ path?: string; sha?: string; mode?: string; type?: string }>;
}
