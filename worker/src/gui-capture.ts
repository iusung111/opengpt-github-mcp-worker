import { AppEnv } from './types';
import { getSelfCurrentUrl, getSelfLiveUrl } from './utils';

export interface GuiCaptureAnalysisConfig {
	target_column?: string;
	aggregate?: 'count' | 'sum' | 'average';
	sort?: 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc';
	missing?: 'exclude' | 'bucket';
	chart_type?: 'auto' | 'bar' | 'histogram';
	filter_text?: string;
}

export interface GuiCaptureInstructions {
	app_url: string;
	file_name: string;
	file_text: string;
	analysis?: GuiCaptureAnalysisConfig;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] |
		(bytes[offset + 1] << 8) |
		(bytes[offset + 2] << 16) |
		(bytes[offset + 3] << 24)
	) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
	for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
		if (
			bytes[offset] === 0x50 &&
			bytes[offset + 1] === 0x4b &&
			bytes[offset + 2] === 0x05 &&
			bytes[offset + 3] === 0x06
		) {
			return offset;
		}
	}
	throw new Error('zip end of central directory not found');
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream !== 'function') {
		throw new Error('DecompressionStream is not available in this runtime');
	}
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	const buffer = await new Response(stream).arrayBuffer();
	return new Uint8Array(buffer);
}

export async function extractZipEntries(zipBytes: ArrayBuffer): Promise<Map<string, Uint8Array>> {
	const bytes = new Uint8Array(zipBytes);
	const eocdOffset = findEndOfCentralDirectory(bytes);
	const entryCount = readUint16LE(bytes, eocdOffset + 10);
	const centralDirectoryOffset = readUint32LE(bytes, eocdOffset + 16);
	const entries = new Map<string, Uint8Array>();
	let offset = centralDirectoryOffset;

	for (let index = 0; index < entryCount; index += 1) {
		if (
			bytes[offset] !== 0x50 ||
			bytes[offset + 1] !== 0x4b ||
			bytes[offset + 2] !== 0x01 ||
			bytes[offset + 3] !== 0x02
		) {
			throw new Error('invalid zip central directory entry');
		}

		const compressionMethod = readUint16LE(bytes, offset + 10);
		const compressedSize = readUint32LE(bytes, offset + 20);
		const fileNameLength = readUint16LE(bytes, offset + 28);
		const extraLength = readUint16LE(bytes, offset + 30);
		const commentLength = readUint16LE(bytes, offset + 32);
		const localHeaderOffset = readUint32LE(bytes, offset + 42);
		const fileNameStart = offset + 46;
		const fileName = new TextDecoder().decode(bytes.slice(fileNameStart, fileNameStart + fileNameLength));

		if (
			bytes[localHeaderOffset] !== 0x50 ||
			bytes[localHeaderOffset + 1] !== 0x4b ||
			bytes[localHeaderOffset + 2] !== 0x03 ||
			bytes[localHeaderOffset + 3] !== 0x04
		) {
			throw new Error(`invalid local zip header for ${fileName}`);
		}

		const localFileNameLength = readUint16LE(bytes, localHeaderOffset + 26);
		const localExtraLength = readUint16LE(bytes, localHeaderOffset + 28);
		const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
		const compressedBytes = bytes.slice(dataOffset, dataOffset + compressedSize);

		let content: Uint8Array;
		if (compressionMethod === 0) {
			content = compressedBytes;
		} else if (compressionMethod === 8) {
			content = await inflateRaw(compressedBytes);
		} else {
			throw new Error(`unsupported zip compression method ${compressionMethod} for ${fileName}`);
		}

		entries.set(fileName, content);
		offset = fileNameStart + fileNameLength + extraLength + commentLength;
	}

	return entries;
}

export function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function encodeBase64(bytes: Uint8Array): string {
	let value = '';
	for (const byte of bytes) {
		value += String.fromCharCode(byte);
	}
	return btoa(value);
}

export function normalizeGuiCaptureInstructions(
	env: AppEnv,
	input: {
		file_name: string;
		file_text: string;
		app_url?: string;
		analysis?: GuiCaptureAnalysisConfig;
	},
): GuiCaptureInstructions {
	const fileName = input.file_name.trim();
	if (!fileName) {
		throw new Error('file_name is required');
	}
	if (!/\.(csv|tsv|json)$/i.test(fileName)) {
		throw new Error('file_name must end with .csv, .tsv, or .json');
	}
	const fileText = input.file_text;
	if (!fileText.trim()) {
		throw new Error('file_text must not be empty');
	}
	if (fileText.length > 50000) {
		throw new Error('file_text exceeds 50,000 characters');
	}
	const appUrl = input.app_url?.trim() || getSelfCurrentUrl(env) || getSelfLiveUrl(env);
	if (!appUrl) {
		throw new Error('app_url is not configured');
	}
	return {
		app_url: `${appUrl.replace(/\/$/, '')}/gui/`,
		file_name: fileName,
		file_text: fileText,
		analysis: input.analysis,
	};
}
