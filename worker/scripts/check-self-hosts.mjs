import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const wranglerPath = path.join(root, 'wrangler.jsonc');
const wrangler = JSON.parse(fs.readFileSync(wranglerPath, 'utf8'));
const vars = wrangler.vars ?? {};

const liveUrl = String(vars.SELF_LIVE_URL ?? '').replace(/\/$/, '');
const mirrorUrl = String(vars.SELF_MIRROR_URL ?? vars.SELF_LIVE_URL ?? '').replace(/\/$/, '');
const selfRepoKey = String(vars.SELF_REPO_KEY ?? 'iusung111/opengpt-github-mcp-worker');

async function healthz(url) {
	if (!url) {
		return { ok: false, error: 'not configured' };
	}
	try {
		const response = await fetch(`${url}/healthz`);
		const body = await response.text();
		return {
			ok: response.ok,
			status: response.status,
			body,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function gitRemoteInfo() {
	try {
		return execSync('git remote -v', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch {
		return 'git remote lookup failed';
	}
}

const [live, mirror] = await Promise.all([healthz(liveUrl), healthz(mirrorUrl)]);

console.log(
	JSON.stringify(
		{
			self_repo_key: selfRepoKey,
			git_remotes: gitRemoteInfo(),
			live: { url: liveUrl || null, healthz: live },
			mirror: { url: mirrorUrl || null, healthz: mirror },
		},
		null,
		2,
	),
);
