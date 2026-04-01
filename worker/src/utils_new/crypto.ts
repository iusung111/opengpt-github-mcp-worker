export async function sha256Hex(text: string): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildDispatchFingerprint(
	owner: string,
	repo: string,
	workflowId: string,
	ref: string,
	inputs: Record<string, unknown>,
	autoImproveCycle?: number,
): Promise<string> {
	const payload = {
		owner,
		repo,
		workflow_id: workflowId,
		ref,
		inputs,
		auto_improve_cycle: autoImproveCycle ?? null,
	};
	return sha256Hex(JSON.stringify(payload));
}
