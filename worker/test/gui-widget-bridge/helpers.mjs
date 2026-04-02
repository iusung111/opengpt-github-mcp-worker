export function createStyle() {
	const values = new Map();
	return {
		setProperty(name, value) {
			values.set(name, value);
		},
		getPropertyValue(name) {
			return values.get(name) ?? '';
		},
		removeProperty(name) {
			values.delete(name);
		},
	};
}

export function createFakeDocument(referrer = 'https://chatgpt.com/c/app') {
	const styleNodes = new Map();
	const headChildren = [];
	const documentElement = { dataset: {}, style: createStyle() };
	const head = {
		appendChild(node) {
			headChildren.push(node);
			if (node.id) styleNodes.set(node.id, node);
		},
	};
	return {
		referrer,
		documentElement,
		head,
		createElement() {
			return {
				id: '',
				textContent: '',
				remove() {
					if (this.id) styleNodes.delete(this.id);
				},
			};
		},
		getElementById(id) {
			return styleNodes.get(id) ?? null;
		},
		headChildren,
	};
}

export function createFakeWindow(origin = 'https://widget.example.com') {
	const listeners = new Map();
	const posted = [];
	const parent = {
		postMessage(message, targetOrigin) {
			posted.push({ message, targetOrigin });
		},
	};
	return {
		location: { origin },
		parent,
		addEventListener(type, handler) {
			listeners.set(type, handler);
		},
		removeEventListener(type) {
			listeners.delete(type);
		},
		dispatchMessage(event) {
			const handler = listeners.get('message');
			if (handler) handler(event);
		},
		posted,
	};
}
