export type UploadSessionState = 'open' | 'committing' | 'committed' | 'aborted' | 'expired';

export interface UploadSessionRecord {
	upload_id: string;
	owner: string;
	repo: string;
	branch: string;
	path: string;
	message: string;
	expected_blob_sha?: string | null;
	content_kind?: 'text' | 'binary' | null;
	mime_type?: string | null;
	total_bytes?: number | null;
	recommended_chunk_bytes: number;
	base_ref_sha: string;
	existing_blob_sha?: string | null;
	state: UploadSessionState;
	next_chunk_index: number;
	next_byte_offset: number;
	received_bytes: number;
	chunk_count: number;
	chunk_byte_lengths?: number[];
	commit_attempts?: number;
	created_at: string;
	expires_at: string;
	committed_at?: string | null;
	last_error?: string | null;
	last_failed_at?: string | null;
}
