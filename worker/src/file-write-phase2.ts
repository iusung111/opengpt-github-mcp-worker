export type Phase2FileWriteMode = 'create' | 'upsert' | 'update';

export interface Phase2FileWriteOptions {
	mode: Phase2FileWriteMode;
	expectedBlobSha?: string | null;
	probedBlobSha?: string | null;
}

export function shouldProbeExistingFile(mode: Phase2FileWriteMode): boolean {
	return mode === 'upsert';
}

export function resolveExpectedBlobSha({
	mode,
	expectedBlobSha,
	probedBlobSha,
}: Phase2FileWriteOptions): string | null {
	if (expectedBlobSha) {
		return expectedBlobSha;
	}
	if (mode === 'upsert') {
		return probedBlobSha ?? null;
	}
	return null;
}

export const PHASE2_FILE_WRITE_READY = true;
