import { ProjectCapabilities, renderPreviewUrlTemplate } from '../project-capabilities';
import { AppEnv, JobVerificationStepRecord } from '../contracts';
import { dispatchStandardWorkflow, listWorkflowArtifacts, readSummaryArtifact } from '../workflow-execution';
import { isRecord } from './job-state';

export function previewStatusFromSummary(
	conclusion: string | null,
	urls: Record<string, string>,
): 'creating' | 'ready' | 'failed' {
	if (conclusion && conclusion !== 'success') {
		return 'failed';
	}
	return Object.keys(urls).length > 0 ? 'ready' : 'creating';
}

export function runStatusFromConclusion(conclusion: string | null): 'passed' | 'failed' | 'partial' {
	if (conclusion === 'success') return 'passed';
	if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') return 'failed';
	return 'partial';
}

export function normalizeStepStatus(value: unknown): JobVerificationStepRecord['status'] {
	if (
		value === 'queued' ||
		value === 'running' ||
		value === 'passed' ||
		value === 'failed' ||
		value === 'skipped' ||
		value === 'partial'
	) {
		return value;
	}
	if (value === 'success' || value === 'pass') return 'passed';
	if (value === 'error' || value === 'fail') return 'failed';
	return 'partial';
}

export function buildVerificationSteps(
	summary: Record<string, unknown> | null,
	fallbackName: string,
	conclusion: string | null,
): JobVerificationStepRecord[] {
	const summarySteps = Array.isArray(summary?.steps) ? summary.steps : [];
	const steps: JobVerificationStepRecord[] = [];
	for (let index = 0; index < summarySteps.length; index += 1) {
		const entry = summarySteps[index];
		if (!isRecord(entry)) {
			continue;
		}
		steps.push({
			name:
				typeof entry.name === 'string' && entry.name.trim()
					? entry.name.trim()
					: `${fallbackName}-${index + 1}`,
			status: normalizeStepStatus(entry.status),
			duration_ms: typeof entry.duration_ms === 'number' ? entry.duration_ms : null,
			artifact_ids: Array.isArray(entry.artifact_ids)
				? entry.artifact_ids.filter(
						(item): item is string => typeof item === 'string' && item.trim().length > 0,
				  )
				: undefined,
			log_excerpt:
				typeof entry.stderr_excerpt === 'string'
					? entry.stderr_excerpt
					: typeof entry.stdout_excerpt === 'string'
						? entry.stdout_excerpt
						: typeof entry.log_excerpt === 'string'
							? entry.log_excerpt
							: null,
		});
	}
	if (steps.length > 0) {
		return steps;
	}
	return [
		{
			name: fallbackName,
			status: runStatusFromConclusion(conclusion),
			log_excerpt: null,
		},
	];
}

export function derivePreviewUrls(
	capabilities: ProjectCapabilities,
	owner: string,
	repo: string,
	ref: string,
	summary: Record<string, unknown> | null,
	serviceOverride?: string,
): Record<string, string> {
	const result: Record<string, string> = {};
	const summaryOutputs = isRecord(summary?.outputs) ? summary.outputs : null;
	const summaryPreview = isRecord(summaryOutputs?.preview)
		? summaryOutputs.preview
		: isRecord(summary?.preview)
			? summary.preview
			: null;
	const summaryUrls = isRecord(summaryPreview?.urls)
		? summaryPreview.urls
		: isRecord(summary?.urls)
			? summary.urls
			: null;
	if (summaryUrls) {
		for (const [key, value] of Object.entries(summaryUrls)) {
			if (typeof value === 'string' && value.trim()) {
				result[key] = value.trim();
			}
		}
	}
	if (Object.keys(result).length > 0) {
		return result;
	}
	if (!capabilities.web_preview.url_template) {
		return result;
	}
	const services = serviceOverride
		? [serviceOverride]
		: capabilities.web_preview.services.length > 0
			? capabilities.web_preview.services
			: ['web'];
	for (const service of services) {
		result[service] = renderPreviewUrlTemplate(capabilities.web_preview.url_template, {
			owner,
			repo,
			ref,
			service,
		});
	}
	return result;
}

export function getSummaryOverallStatus(summary: Record<string, unknown> | null): string | null {
	const result = isRecord(summary?.result) ? summary.result : null;
	if (typeof result?.overall_status === 'string' && result.overall_status.trim()) {
		return result.overall_status.trim();
	}
	if (typeof summary?.status === 'string' && summary.status.trim()) {
		return summary.status.trim();
	}
	return null;
}

export function summarizeRun(
	repoKey: string,
	ref: string,
	workflowId: string,
	result: Awaited<ReturnType<typeof dispatchStandardWorkflow>>,
): Record<string, unknown> {
	return {
		repo: repoKey,
		ref,
		workflow_id: workflowId,
		run_id: result.run_id,
		run_html_url: result.run_html_url,
		status: result.status,
		conclusion: result.conclusion,
		summary: result.summary,
		artifacts: result.artifacts,
	};
}

export function normalizeLogEntries(
	logEntries: Map<string, Uint8Array>,
	query: string | undefined,
	tailLines: number,
	fileName?: string,
	limit = 20,
): Record<string, unknown> {
	const normalizedQuery = query?.trim().toLowerCase() ?? '';
	const entries: Array<Record<string, unknown>> = [];
	for (const [name, bytes] of Array.from(logEntries.entries()).sort(([left], [right]) => left.localeCompare(right))) {
		if (fileName && name !== fileName) {
			continue;
		}
		const text = new TextDecoder().decode(bytes);
		const lines = text.split(/\r?\n/);
		const matchedLines = normalizedQuery
			? lines.filter((line) => line.toLowerCase().includes(normalizedQuery))
			: lines;
		entries.push({
			file_name: name,
			line_count: lines.length,
			match_count: matchedLines.length,
			tail: matchedLines.slice(-tailLines),
		});
	}
	return {
		files: entries.slice(0, limit),
		file_count: entries.length,
	};
}

export function buildErrorFingerprint(line: string): string {
	return line
		.toLowerCase()
		.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
		.replace(/\b\d+\b/g, '<n>')
		.replace(/https?:\/\/\S+/g, '<url>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

export function browserDiagnosticsFromSummary(summary: Record<string, unknown> | null): Record<string, unknown> {
	const logs = isRecord(summary?.logs) ? summary.logs : {};
	return {
		overall_status: getSummaryOverallStatus(summary),
		console_count: typeof logs.console_count === 'number' ? logs.console_count : 0,
		page_error_count: typeof logs.page_error_count === 'number' ? logs.page_error_count : 0,
		network_error_count: typeof logs.network_error_count === 'number' ? logs.network_error_count : 0,
	};
}

export function normalizeContractValidation(path: string, text: string): Record<string, unknown> {
	const lowerPath = path.toLowerCase();
	const findings: string[] = [];
	let format: 'json' | 'yaml' | 'text' = 'text';
	let valid = true;
	let openapiVersion: string | null = null;
	if (lowerPath.endsWith('.json')) {
		format = 'json';
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (typeof parsed.openapi === 'string') {
				openapiVersion = parsed.openapi;
			} else if (typeof parsed.swagger === 'string') {
				openapiVersion = parsed.swagger;
			} else {
				findings.push('json contract file does not declare openapi/swagger version');
			}
		} catch (error) {
			valid = false;
			findings.push(`invalid json: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else if (lowerPath.endsWith('.yml') || lowerPath.endsWith('.yaml')) {
		format = 'yaml';
		const match = text.match(/^\s*(openapi|swagger)\s*:\s*["']?([^"'\n]+)["']?/m);
		if (match) {
			openapiVersion = match[2].trim();
		} else {
			findings.push('yaml contract file does not declare openapi/swagger version');
		}
		if (!/^\s*paths\s*:/m.test(text)) {
			findings.push('yaml contract file does not define paths');
		}
	}
	return {
		path,
		format,
		valid,
		openapi_version: openapiVersion,
		findings,
	};
}

export async function fetchRunSummary(
	env: AppEnv,
	owner: string,
	repo: string,
	runId: number,
): Promise<{ summary: Record<string, unknown> | null; artifacts: Array<Record<string, unknown>> }> {
	const artifacts = await listWorkflowArtifacts(env, owner, repo, runId);
	return {
		artifacts,
		summary: await readSummaryArtifact(env, owner, repo, runId, artifacts),
	};
}

export function buildReleaseGates(input: {
	verifyStatus?: string | null;
	previewStatus?: string | null;
	browserStatus?: string | null;
	desktopStatus?: string | null;
}): Array<Record<string, unknown>> {
	return [
		{ id: 'verify_pass', ok: input.verifyStatus === 'passed' || input.verifyStatus === 'success', status: input.verifyStatus ?? 'missing' },
		{ id: 'preview_healthy', ok: input.previewStatus === 'ready', status: input.previewStatus ?? 'missing' },
		{ id: 'browser_smoke_pass', ok: input.browserStatus === 'passed' || input.browserStatus === 'success', status: input.browserStatus ?? 'missing' },
		{ id: 'desktop_smoke_pass', ok: input.desktopStatus === 'passed' || input.desktopStatus === 'success', status: input.desktopStatus ?? 'missing' },
	];
}

