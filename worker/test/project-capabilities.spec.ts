import { describe, expect, it } from 'vitest';
import { renderPreviewUrlTemplate, resolveVerifyProfile } from '../src/project-capabilities';

describe('project capabilities helpers', () => {
	it('renders preview url templates with repo and ref placeholders', () => {
		expect(
			renderPreviewUrlTemplate('https://{service}-{repo}.example.com/{ref}', {
				owner: 'iusung111',
				repo: 'OpenGPT',
				ref: 'agent/demo-branch',
				service: 'web',
			}),
		).toBe('https://web-OpenGPT.example.com/agent%2Fdemo-branch');
	});

	it('resolves an explicit verify profile when present', () => {
		expect(
			resolveVerifyProfile(
				{
					runtime_kind: 'webview_desktop_shell',
					desktop_shell: 'electron',
					verify_profiles: [
						{ id: 'frontend', label: 'Frontend', commands: ['npm run test'], kind: 'verify' },
						{ id: 'desktop-build', label: 'Desktop build', commands: ['npm run build'], kind: 'desktop_build' },
					],
					package_targets: [],
					web_preview: { enabled: true, services: ['web'], ttl_minutes: 240 },
					api_contract_sources: [],
					db_mode: 'none',
					workflow_ids: {
						verify: 'opengpt-exec.yml',
						package: 'opengpt-package.yml',
						preview: 'opengpt-exec.yml',
						release: 'opengpt-exec.yml',
						db: 'opengpt-exec.yml',
					},
					desktop: { build_commands: [], smoke_commands: [], artifact_paths: [] },
					db: {
						migration_commands: [],
						seed_commands: [],
						reset_commands: [],
						query_command: null,
						inspect_paths: [],
					},
					runtime: { log_source: 'workflow' },
					source: { capabilities_file_found: false, package_json_found: false },
				},
				'desktop-build',
			),
		).toMatchObject({
			id: 'desktop-build',
			kind: 'desktop_build',
		});
	});
});
