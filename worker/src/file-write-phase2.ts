export const PHASE2_FILE_WRITE_READY = true;

export type Phase2FileWriteMode = 'create' | 'upsert' | 'update';

export interface Phase2FileWriteOptions {
	mode: Phase2FileWriteMode;
}

export function shouldProbeExistingFile(mode: Phase2FileWriteMode): boolean {
	return mode === 'create' || mode === 'upsert';
}
