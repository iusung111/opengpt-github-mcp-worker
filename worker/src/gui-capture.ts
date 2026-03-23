import { AppEnv } from './types';
import { getSelfCurrentUrl, getSelfLiveUrl } from './utils';

export interface GuiCaptureLegacyAnalysisConfig {
	target_column?: string;
	aggregate?: 'count' | 'sum' | 'average';
	sort?: 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc';
	missing?: 'exclude' | 'bucket';
	chart_type?: 'auto' | 'bar' | 'histogram';
	filter_text?: string;
}

export type GuiScenarioAction =
	| 'open'
	| 'click'
	| 'type'
	| 'select'
	| 'hover'
	| 'scroll'
	| 'wait_for'
	| 'assert_visible'
	| 'assert_text'
	| 'assert_count'
	| 'assert_attribute'
	| 'screenshot';

export interface GuiCaptureScenarioStep {
	id?: string;
	action: GuiScenarioAction;
	selector?: string;
	value?: string;
	url?: string;
	timeout_ms?: number;
	capture?: 'none' | 'after' | 'before_after';
	name?: string;
	expected_text?: string;
	expected_count?: number;
	attribute_name?: string;
	expected_value?: string;
}

export interface GuiCaptureScenarioConfig {
	name?: string;
	viewport?: { width: number; height: number };
	stop_on_failure?: boolean;
	steps: GuiCaptureScenarioStep[];
}

export interface GuiCaptureReportConfig {
	format?: 'markdown';
	include_step_images?: boolean;
	include_console_logs?: boolean;
	include_network_errors?: boolean;
}

export type GuiCaptureMode = 'legacy_analysis' | 'html_scenario' | 'url_scenario';

export interface GuiCaptureInstructions {
	mode: GuiCaptureMode;
	app_url?: string;
	file_name?: string;
	file_text?: string;
	analysis?: GuiCaptureLegacyAnalysisConfig;
	scenario?: GuiCaptureScenarioConfig;
	report?: GuiCaptureReportConfig;
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

function normalizeScenarioSteps(steps: GuiCaptureScenarioStep[]): GuiCaptureScenarioStep[] {
	return steps.map((step, index) => ({
		...step,
		id: step.id?.trim() || `step-${index + 1}`,
		name: step.name?.trim() || `${step.action}-${index + 1}`,
		capture: step.capture ?? 'after',
		timeout_ms: step.timeout_ms ?? 10_000,
	}));
}

function normalizeReportConfig(report?: GuiCaptureReportConfig): GuiCaptureReportConfig | undefined {
	if (!report) return undefined;
	return {
		format: 'markdown',
		include_step_images: report.include_step_images !== false,
		include_console_logs: report.include_console_logs !== false,
		include_network_errors: report.include_network_errors !== false,
	};
}

export function normalizeGuiCaptureInstructions(
	env: AppEnv,
	input: {
		file_name?: string;
		file_text?: string;
		app_url?: string;
		analysis?: GuiCaptureLegacyAnalysisConfig;
		scenario?: GuiCaptureScenarioConfig;
		report?: GuiCaptureReportConfig;
	},
): GuiCaptureInstructions {
	const fileName = input.file_name?.trim();
	const fileText = input.file_text ?? '';
	const scenario = input.scenario;
	const report = normalizeReportConfig(input.report);
	const appUrl = (input.app_url?.trim() || getSelfCurrentUrl(env) || getSelfLiveUrl(env) || '').replace(/\/$/, '');

	if (scenario) {
		if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
			throw new Error('scenario.steps must contain at least one step');
		}
		const normalizedScenario: GuiCaptureScenarioConfig = {
			name: scenario.name?.trim() || 'gui validation scenario',
			viewport: scenario.viewport ?? { width: 1440, height: 900 },
			stop_on_failure: scenario.stop_on_failure !== false,
			steps: normalizeScenarioSteps(scenario.steps),
		};

		if (fileName) {
			if (!/\.html?$/i.test(fileName)) {
				throw new Error('scenario file_name must end with .html');
			}
			if (!fileText.trim()) {
				throw new Error('scenario file_text must not be empty');
			}
			if (fileText.length > 200_000) {
				throw new Error('scenario file_text exceeds 200,000 characters');
			}
			return {
				mode: 'html_scenario',
				app_url: appUrl || undefined,
				file_name: fileName,
				file_text: fileText,
				scenario: normalizedScenario,
				report,
			};
		}

		if (!appUrl) {
			throw new Error('app_url is required for url_scenario mode');
		}
		return {
			mode: 'url_scenario',
			app_url: appUrl,
			scenario: normalizedScenario,
			report,
		};
	}

	if (!fileName) {
		throw new Error('file_name is required');
	}
	if (!/\.(csv|tsv|json)$/i.test(fileName)) {
		throw new Error('file_name must end with .csv, .tsv, or .json unless scenario mode is used');
	}
	if (!fileText.trim()) {
		throw new Error('file_text must not be empty');
	}
	if (fileText.length > 50_000) {
		throw new Error('file_text exceeds 50,000 characters');
	}
	if (!appUrl) {
		throw new Error('app_url is not configured');
	}
	return {
		mode: 'legacy_analysis',
		app_url: `${appUrl}/gui/`,
		file_name: fileName,
		file_text: fileText,
		analysis: input.analysis,
		report,
	};
}
