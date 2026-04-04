import type {
	JobApprovalManifest,
	JobControlManifest,
	JobInterruptRecord,
	JobRecord,
	JobWorkerManifest,
	RunAttentionStatus,
} from '../../contracts';

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function getApprovalManifest(manifest: JobWorkerManifest | undefined): JobApprovalManifest | null {
	const approval = manifest?.attention?.approval;
	return approval && typeof approval === 'object' ? approval : null;
}

export function getControlManifest(manifest: JobWorkerManifest | undefined): JobControlManifest | null {
	const control = manifest?.control;
	return control && typeof control === 'object' ? control : null;
}

export function getLastInterrupt(manifest: JobWorkerManifest | undefined): JobInterruptRecord | null {
	const interrupt = getControlManifest(manifest)?.last_interrupt;
	return interrupt && typeof interrupt === 'object' ? interrupt : null;
}

export function interruptMessage(interrupt: JobInterruptRecord | null): string | null {
	return asString(interrupt?.message);
}

function hasActiveManifestSection(manifest: JobWorkerManifest | undefined): boolean {
	const verificationStatus = manifest?.verification?.status;
	const previewStatus = manifest?.preview?.status;
	const browserStatus = manifest?.browser?.status;
	const desktopStatus = manifest?.desktop?.status;
	const runtimeStatus = manifest?.runtime?.status;
	return (
		verificationStatus === 'queued' ||
		verificationStatus === 'running' ||
		previewStatus === 'creating' ||
		previewStatus === 'destroying' ||
		browserStatus === 'running' ||
		desktopStatus === 'building' ||
		desktopStatus === 'smoke_running' ||
		runtimeStatus === 'collecting'
	);
}

function isApprovalResolvedAwaitingFollowup(job: JobRecord): boolean {
	const approval = getApprovalManifest(job.worker_manifest);
	const control = getControlManifest(job.worker_manifest);
	const hasDispatch = Boolean(job.worker_manifest?.dispatch_request || job.worker_manifest?.execution?.dispatch_request);
	return Boolean(
		approval?.status === 'approved' &&
		!approval.pending &&
		control?.state !== 'paused' && control?.state !== 'cancelled' &&
		job.status === 'queued' && job.next_actor === 'worker' && !hasDispatch,
	);
}

export function computeRunAttentionStatus(job: JobRecord): RunAttentionStatus {
	const control = getControlManifest(job.worker_manifest);
	const approval = getApprovalManifest(job.worker_manifest);
	const interrupt = getLastInterrupt(job.worker_manifest);
	if (control?.state === 'cancelled') {
		return 'cancelled';
	}
	if (control?.state === 'paused') {
		return 'paused';
	}
	if (approval?.pending) {
		return 'pending_approval';
	}
	if (interrupt) {
		return 'interrupted';
	}
	if (job.status === 'failed' || job.review_verdict === 'blocked') {
		return 'failed';
	}
	if (job.status === 'done') {
		return 'completed';
	}
	if (isApprovalResolvedAwaitingFollowup(job)) {
		return 'running';
	}
	if (job.status === 'working' || hasActiveManifestSection(job.worker_manifest)) {
		return 'running';
	}
	return 'idle';
}

export function computeRunnableDiagnostics(job: JobRecord) {
	const approval = getApprovalManifest(job.worker_manifest);
	const control = getControlManifest(job.worker_manifest);
	const hasDispatch = Boolean(job.worker_manifest?.dispatch_request || job.worker_manifest?.execution?.dispatch_request);
	if (isApprovalResolvedAwaitingFollowup(job)) {
		return {
			runnable: true,
			idle_reason: null,
			missing_requirements: [],
			missing_capabilities: [],
		};
	}
	const activeSection = hasActiveManifestSection(job.worker_manifest);
	const runnable = Boolean(hasDispatch || approval?.pending || job.status === 'working' || job.status === 'rework_pending' || activeSection);
	if (runnable) {
		return {
			runnable: true,
			idle_reason: null,
			missing_requirements: [],
			missing_capabilities: [],
		};
	}
	if (control?.state === 'cancelled') {
		return {
			runnable: false,
			idle_reason: 'cancelled_job',
			missing_requirements: [],
			missing_capabilities: [],
		};
	}
	return {
		runnable: false,
		idle_reason: 'queued_without_dispatch_request',
		missing_requirements: ['dispatch_request'],
		missing_capabilities: [],
	};
}
