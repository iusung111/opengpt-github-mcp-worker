import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function ensureDir(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

function decodeRequest() {
	const explicit = process.env.OPENGPT_REQUEST_B64 || '';
	if (explicit) {
		return JSON.parse(Buffer.from(explicit, 'base64').toString('utf8'));
	}
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath || !fs.existsSync(eventPath)) {
		return {};
	}
	const eventPayload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
	const requestB64 = eventPayload.inputs?.request_b64 ?? '';
	if (!requestB64) {
		return {};
	}
	return JSON.parse(Buffer.from(requestB64, 'base64').toString('utf8'));
}

function sanitizeName(value, fallback) {
	return String(value ?? fallback)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48) || fallback;
}

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function collectExistingPaths(rootDir, artifactDir, relativePaths = []) {
	const copied = [];
	for (const relativePath of relativePaths) {
		if (!relativePath || typeof relativePath !== 'string') continue;
		const sourcePath = path.resolve(rootDir, relativePath);
		if (!fs.existsSync(sourcePath)) continue;
		const destinationPath = path.join(artifactDir, 'outputs', relativePath);
		ensureDir(path.dirname(destinationPath));
		const stat = fs.statSync(sourcePath);
		if (stat.isDirectory()) {
			fs.cpSync(sourcePath, destinationPath, { recursive: true });
		} else {
			fs.copyFileSync(sourcePath, destinationPath);
		}
		copied.push(relativePath);
	}
	return copied;
}

function runCommand(command, env) {
	const startedAt = Date.now();
	const result = spawnSync(command, {
		shell: true,
		encoding: 'utf8',
		env,
		stdio: 'pipe',
	});
	return {
		command,
		exit_code: typeof result.status === 'number' ? result.status : 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		duration_ms: Date.now() - startedAt,
	};
}

export function executeWorkflowRequest(input) {
	const request = decodeRequest();
	const artifactDir = path.join(process.cwd(), input.artifactDirName);
	const logsDir = path.join(artifactDir, 'logs');
	ensureDir(artifactDir);
	ensureDir(logsDir);

	const commands = Array.isArray(request.commands)
		? request.commands.filter((item) => typeof item === 'string' && item.trim())
		: [];
	if (request.query_command && typeof request.query_command === 'string') {
		commands.push(request.query_command);
	}

	const steps = [];
	let overallStatus = 'passed';
	const baseEnv = {
		...process.env,
		OPENGPT_REQUEST_KIND: String(request.kind ?? input.defaultKind),
		OPENGPT_QUERY_TEXT: typeof request.query_text === 'string' ? request.query_text : '',
	};

	for (let index = 0; index < commands.length; index += 1) {
		const command = commands[index];
		const result = runCommand(command, baseEnv);
		const name = `${String(index + 1).padStart(2, '0')}-${sanitizeName(command, `step-${index + 1}`)}`;
		fs.writeFileSync(path.join(logsDir, `${name}.stdout.log`), result.stdout, 'utf8');
		fs.writeFileSync(path.join(logsDir, `${name}.stderr.log`), result.stderr, 'utf8');
		const status = result.exit_code === 0 ? 'passed' : 'failed';
		steps.push({
			name: request.step_names?.[index] ?? command,
			status,
			exit_code: result.exit_code,
			duration_ms: result.duration_ms,
			stdout_excerpt: result.stdout.slice(-4000),
			stderr_excerpt: result.stderr.slice(-4000),
		});
		if (status === 'failed') {
			overallStatus = 'failed';
			if (request.continue_on_error !== true) {
				break;
			}
		}
	}

	if (commands.length === 0) {
		overallStatus = 'partial';
		steps.push({
			name: String(request.kind ?? input.defaultKind),
			status: 'partial',
			exit_code: 0,
			duration_ms: 0,
			stdout_excerpt: '',
			stderr_excerpt: 'no commands were configured for this request',
		});
	}

	const copiedArtifacts = collectExistingPaths(
		process.cwd(),
		artifactDir,
		Array.isArray(request.artifact_paths) ? request.artifact_paths : Array.isArray(input.defaultArtifactPaths) ? input.defaultArtifactPaths : [],
	);

	const summary = {
		ok: overallStatus !== 'failed',
		kind: String(request.kind ?? input.defaultKind),
		request: {
			request_id: request.request_id ?? null,
			profile_id: request.profile_id ?? null,
			label: request.label ?? null,
			deploy_target: request.deploy_target ?? null,
			package_targets: Array.isArray(request.package_targets) ? request.package_targets : [],
		},
		result: {
			overall_status: overallStatus,
			step_count: steps.length,
			passed_steps: steps.filter((step) => step.status === 'passed').length,
			failed_steps: steps.filter((step) => step.status === 'failed').length,
		},
		steps,
		outputs: {
			preview: request.preview ?? null,
			release: request.release ?? null,
			copied_artifacts: copiedArtifacts,
		},
	};

	writeJson(path.join(artifactDir, 'summary.json'), summary);
	writeJson(path.join(artifactDir, 'request.json'), request);
	return { summary, artifactDir };
}
