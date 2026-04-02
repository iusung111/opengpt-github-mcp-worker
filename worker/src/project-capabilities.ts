import { AppEnv } from './contracts';
import { decodeBase64Text, encodeGitHubPath, ensureRepoAllowed, getDefaultBaseBranch, githubGet } from './utils';

export interface ProjectVerifyProfile {
	id: string;
	label: string;
	commands: string[];
	kind: 'verify' | 'desktop_build' | 'desktop_smoke' | 'db_migration' | 'db_seed' | 'db_reset' | 'db_query';
}

export interface ProjectCapabilities {
	runtime_kind: string;
	desktop_shell: string | null;
	verify_profiles: ProjectVerifyProfile[];
	package_targets: string[];
	web_preview: {
		enabled: boolean;
		url_template?: string;
		healthcheck_path?: string;
		services: string[];
		ttl_minutes: number;
		create_commands?: string[];
		destroy_commands?: string[];
	};
	api_contract_sources: string[];
	db_mode: string;
	workflow_ids: {
		verify: string;
		package: string;
		preview: string;
		release: string;
		db: string;
	};
	desktop: {
		build_commands: string[];
		smoke_commands: string[];
		artifact_paths: string[];
	};
	db: {
		migration_commands: string[];
		seed_commands: string[];
		reset_commands: string[];
		query_command: string | null;
		inspect_paths: string[];
	};
	runtime: {
		log_source: 'workflow' | 'url';
		log_url_template?: string;
	};
	source: {
		capabilities_file_found: boolean;
		package_json_found: boolean;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isGitHubNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('github request failed:') && message.includes(' 404 ');
}


function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => (typeof item === 'string' ? item.trim() : ''))
		.filter(Boolean);
}

function defaultCapabilities(): ProjectCapabilities {
	return {
		runtime_kind: 'webview_desktop_shell',
		desktop_shell: null,
		verify_profiles: [],
		package_targets: [],
		web_preview: {
			enabled: false,
			services: ['web'],
			ttl_minutes: 240,
		},
		api_contract_sources: [],
		db_mode: 'none',
		workflow_ids: {
			verify: 'opengpt-exec.yml',
			package: 'opengpt-package.yml',
			preview: 'opengpt-exec.yml',
			release: 'opengpt-exec.yml',
			db: 'opengpt-exec.yml',
		},
		desktop: {
			build_commands: [],
			smoke_commands: [],
			artifact_paths: [],
		},
		db: {
			migration_commands: [],
			seed_commands: [],
			reset_commands: [],
			query_command: null,
			inspect_paths: ['schema.prisma', 'prisma/schema.prisma', 'drizzle', 'migrations', 'db'],
		},
		runtime: {
			log_source: 'workflow',
		},
		source: {
			capabilities_file_found: false,
			package_json_found: false,
		},
	};
}

async function getOptionalRepoTextFile(
	env: AppEnv,
	owner: string,
	repo: string,
	path: string,
	ref: string,
): Promise<string | null> {
	try {
		const data = (await githubGet(env, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
			params: { ref },
		})) as { content?: string; type?: string };
		if (data.type && data.type !== 'file') {
			return null;
		}
		return decodeBase64Text(data.content);
	} catch (error) {
		if (isGitHubNotFoundError(error)) {
			return null;
		}
		throw error;
	}
}

function detectDesktopShellFromPackageJson(packageJson: Record<string, unknown>): string | null {
	const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
	const devDependencies = isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {};
	const allDeps = { ...dependencies, ...devDependencies };
	if ('electron' in allDeps) {
		return 'electron';
	}
	if ('@tauri-apps/api' in allDeps || '@tauri-apps/cli' in allDeps) {
		return 'tauri';
	}
	return null;
}

function deriveVerifyProfilesFromPackageJson(packageJson: Record<string, unknown>): ProjectVerifyProfile[] {
	const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
	const candidates: Array<{ id: string; label: string; script: string; kind: ProjectVerifyProfile['kind'] }> = [
		{ id: 'node-check', label: 'Node check', script: 'check', kind: 'verify' },
		{ id: 'node-typecheck', label: 'Node typecheck', script: 'typecheck', kind: 'verify' },
		{ id: 'node-test-unit', label: 'Node unit tests', script: 'test:unit', kind: 'verify' },
		{ id: 'node-test', label: 'Node tests', script: 'test', kind: 'verify' },
		{ id: 'desktop-build', label: 'Desktop build', script: 'build', kind: 'desktop_build' },
		{ id: 'desktop-smoke', label: 'Desktop smoke', script: 'smoke', kind: 'desktop_smoke' },
	];

	return candidates
		.filter((candidate) => typeof scripts[candidate.script] === 'string')
		.map((candidate) => ({
			id: candidate.id,
			label: candidate.label,
			commands: [`npm run ${candidate.script}`],
			kind: candidate.kind,
		}));
}

function normalizeVerifyProfiles(value: unknown): ProjectVerifyProfile[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const profiles: ProjectVerifyProfile[] = [];
	for (const entry of value) {
		if (typeof entry === 'string') {
			const id = entry.trim();
			if (!id) continue;
			profiles.push({
				id,
				label: id,
				commands: [],
				kind: 'verify',
			});
			continue;
		}
		if (!isRecord(entry) || typeof entry.id !== 'string') {
			continue;
		}
		profiles.push({
			id: entry.id.trim(),
			label: typeof entry.label === 'string' ? entry.label : entry.id.trim(),
			commands: normalizeStringArray(entry.commands),
			kind:
				entry.kind === 'desktop_build' ||
				entry.kind === 'desktop_smoke' ||
				entry.kind === 'db_migration' ||
				entry.kind === 'db_seed' ||
				entry.kind === 'db_reset' ||
				entry.kind === 'db_query'
					? entry.kind
					: 'verify',
		});
	}
	return profiles.filter((profile) => profile.id);
}

export async function resolveProjectCapabilities(
	env: AppEnv,
	owner: string,
	repo: string,
	ref?: string,
): Promise<ProjectCapabilities> {
	const repoKey = `${owner}/${repo}`;
	ensureRepoAllowed(env, repoKey);
	const effectiveRef = ref || getDefaultBaseBranch(env);
	const [capabilitiesText, packageJsonText] = await Promise.all([
		getOptionalRepoTextFile(env, owner, repo, '.opengpt/project-capabilities.json', effectiveRef),
		getOptionalRepoTextFile(env, owner, repo, 'package.json', effectiveRef),
	]);

	const resolved = defaultCapabilities();
	resolved.source.capabilities_file_found = Boolean(capabilitiesText);
	resolved.source.package_json_found = Boolean(packageJsonText);

	if (capabilitiesText) {
		const parsed = JSON.parse(capabilitiesText) as Record<string, unknown>;
		resolved.runtime_kind =
			typeof parsed.runtime_kind === 'string' && parsed.runtime_kind.trim()
				? parsed.runtime_kind.trim()
				: resolved.runtime_kind;
		resolved.desktop_shell =
			typeof parsed.desktop_shell === 'string' && parsed.desktop_shell.trim()
				? parsed.desktop_shell.trim()
				: resolved.desktop_shell;
		const configuredProfiles = normalizeVerifyProfiles(parsed.verify_profiles);
		if (configuredProfiles.length > 0) {
			resolved.verify_profiles = configuredProfiles;
		}
		resolved.package_targets = normalizeStringArray(parsed.package_targets);
		resolved.api_contract_sources = normalizeStringArray(parsed.api_contract_sources);
		resolved.db_mode =
			typeof parsed.db_mode === 'string' && parsed.db_mode.trim() ? parsed.db_mode.trim() : resolved.db_mode;

		if (isRecord(parsed.workflow_ids)) {
			resolved.workflow_ids = {
				verify:
					typeof parsed.workflow_ids.verify === 'string' && parsed.workflow_ids.verify.trim()
						? parsed.workflow_ids.verify.trim()
						: resolved.workflow_ids.verify,
				package:
					typeof parsed.workflow_ids.package === 'string' && parsed.workflow_ids.package.trim()
						? parsed.workflow_ids.package.trim()
						: resolved.workflow_ids.package,
				preview:
					typeof parsed.workflow_ids.preview === 'string' && parsed.workflow_ids.preview.trim()
						? parsed.workflow_ids.preview.trim()
						: resolved.workflow_ids.preview,
				release:
					typeof parsed.workflow_ids.release === 'string' && parsed.workflow_ids.release.trim()
						? parsed.workflow_ids.release.trim()
						: resolved.workflow_ids.release,
				db:
					typeof parsed.workflow_ids.db === 'string' && parsed.workflow_ids.db.trim()
						? parsed.workflow_ids.db.trim()
						: resolved.workflow_ids.db,
			};
		}

		if (isRecord(parsed.web_preview)) {
			resolved.web_preview = {
				enabled: parsed.web_preview.enabled !== false,
				url_template:
					typeof parsed.web_preview.url_template === 'string' && parsed.web_preview.url_template.trim()
						? parsed.web_preview.url_template.trim()
						: undefined,
				healthcheck_path:
					typeof parsed.web_preview.healthcheck_path === 'string' &&
					parsed.web_preview.healthcheck_path.trim()
						? parsed.web_preview.healthcheck_path.trim()
						: undefined,
				services: normalizeStringArray(parsed.web_preview.services).length
					? normalizeStringArray(parsed.web_preview.services)
					: resolved.web_preview.services,
				ttl_minutes:
					typeof parsed.web_preview.ttl_minutes === 'number' && parsed.web_preview.ttl_minutes > 0
						? parsed.web_preview.ttl_minutes
						: resolved.web_preview.ttl_minutes,
				create_commands: normalizeStringArray(parsed.web_preview.create_commands),
				destroy_commands: normalizeStringArray(parsed.web_preview.destroy_commands),
			};
		}

		if (isRecord(parsed.desktop)) {
			resolved.desktop = {
				build_commands: normalizeStringArray(parsed.desktop.build_commands),
				smoke_commands: normalizeStringArray(parsed.desktop.smoke_commands),
				artifact_paths: normalizeStringArray(parsed.desktop.artifact_paths),
			};
		}

		if (isRecord(parsed.db)) {
			resolved.db = {
				migration_commands: normalizeStringArray(parsed.db.migration_commands),
				seed_commands: normalizeStringArray(parsed.db.seed_commands),
				reset_commands: normalizeStringArray(parsed.db.reset_commands),
				query_command:
					typeof parsed.db.query_command === 'string' && parsed.db.query_command.trim()
						? parsed.db.query_command.trim()
						: null,
				inspect_paths: normalizeStringArray(parsed.db.inspect_paths).length
					? normalizeStringArray(parsed.db.inspect_paths)
					: resolved.db.inspect_paths,
			};
		}

		if (isRecord(parsed.runtime)) {
			resolved.runtime = {
				log_source: parsed.runtime.log_source === 'url' ? 'url' : 'workflow',
				log_url_template:
					typeof parsed.runtime.log_url_template === 'string' && parsed.runtime.log_url_template.trim()
						? parsed.runtime.log_url_template.trim()
						: undefined,
			};
		}
	}

	if (packageJsonText) {
		try {
			const packageJson = JSON.parse(packageJsonText) as Record<string, unknown>;
			resolved.desktop_shell = resolved.desktop_shell ?? detectDesktopShellFromPackageJson(packageJson);
			if (resolved.verify_profiles.length === 0) {
				resolved.verify_profiles = deriveVerifyProfilesFromPackageJson(packageJson);
			}
			if (resolved.desktop.build_commands.length === 0 && resolved.verify_profiles.some((profile) => profile.id === 'desktop-build')) {
				resolved.desktop.build_commands = resolved.verify_profiles
					.filter((profile) => profile.kind === 'desktop_build')
					.flatMap((profile) => profile.commands);
			}
			if (resolved.desktop.smoke_commands.length === 0 && resolved.verify_profiles.some((profile) => profile.id === 'desktop-smoke')) {
				resolved.desktop.smoke_commands = resolved.verify_profiles
					.filter((profile) => profile.kind === 'desktop_smoke')
					.flatMap((profile) => profile.commands);
			}
		} catch {
			// Ignore malformed package.json discovery and preserve explicit capability config.
		}
	}

	return resolved;
}

export function resolveVerifyProfile(
	capabilities: ProjectCapabilities,
	profileId: string | undefined,
): ProjectVerifyProfile | null {
	if (!profileId) {
		return capabilities.verify_profiles[0] ?? null;
	}
	return capabilities.verify_profiles.find((profile) => profile.id === profileId) ?? null;
}

export function renderPreviewUrlTemplate(
	template: string,
	input: {
		owner: string;
		repo: string;
		ref: string;
		service: string;
	},
): string {
	return template
		.replace(/\{owner\}/g, input.owner)
		.replace(/\{repo\}/g, input.repo)
		.replace(/\{ref\}/g, encodeURIComponent(input.ref))
		.replace(/\{service\}/g, input.service);
}

