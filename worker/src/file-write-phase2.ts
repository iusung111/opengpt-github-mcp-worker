export const PHASE2_FILE_WRITE_READY = true;

export type Phase2FileWriteMode = 'create' | 'upsert' | 'update';

export interface Phase2FileWriteOptions {
	mode: Phase2FileWriteMode;
	expectedBlobSha?: string;
	probedBlobSha?: string;
}

export function shouldProbeExistingFile(mode: Phase2FileWriteMode): boolean {
	return mode === 'create' || mode === 'upsert';
}

export function resolveExpectedBlobSha({
	mode,
	expectedBlobSha,
	probedBlobSha,
}: Phase2FileWriteOptions): string | undefined {
	if (expectedBlobSha) {
		return expectedBlobSha;
	}

	if (mode === 'upsert') {
		return probedBlobSha;
	}

	return undefined;
}
