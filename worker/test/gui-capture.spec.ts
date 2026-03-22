import { describe, expect, it } from 'vitest';

import { extractZipEntries, normalizeGuiCaptureInstructions, decodeUtf8 } from '../src/gui-capture';

function buildStoredZip(entries: Array<{ name: string; text: string }>): Uint8Array {
	const encoder = new TextEncoder();
	const fileRecords: number[] = [];
	const centralRecords: number[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = Array.from(encoder.encode(entry.name));
		const dataBytes = Array.from(encoder.encode(entry.text));
		const localHeaderOffset = offset;
		const localHeader = [
			0x50, 0x4b, 0x03, 0x04,
			20, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0, 0, 0,
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...dataBytes,
		];
		fileRecords.push(...localHeader);
		offset += localHeader.length;

		const centralHeader = [
			0x50, 0x4b, 0x01, 0x02,
			20, 0,
			20, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0,
			0, 0, 0, 0,
			...u32(dataBytes.length),
			...u32(dataBytes.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(localHeaderOffset),
			...nameBytes,
		];
		centralRecords.push(...centralHeader);
	}

	const centralOffset = fileRecords.length;
	const eocd = [
		0x50, 0x4b, 0x05, 0x06,
		0, 0, 0, 0,
		...u16(entries.length),
		...u16(entries.length),
		...u32(centralRecords.length),
		...u32(centralOffset),
		...u16(0),
	];

	return new Uint8Array([...fileRecords, ...centralRecords, ...eocd]);
}

function u16(value: number): number[] {
	return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
	return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

describe('gui capture helpers', () => {
	it('normalizes gui capture instructions', () => {
		const instructions = normalizeGuiCaptureInstructions(
			{
				SELF_CURRENT_URL: 'https://worker.example.com',
			},
			{
				file_name: 'sample.csv',
				file_text: 'name,value\nalpha,1',
			},
		);
		expect(instructions.app_url).toBe('https://worker.example.com/gui/');
		expect(instructions.file_name).toBe('sample.csv');
	});

	it('rejects unsupported file names', () => {
		expect(() =>
			normalizeGuiCaptureInstructions(
				{
					SELF_CURRENT_URL: 'https://worker.example.com',
				},
				{
					file_name: 'sample.xlsx',
					file_text: 'x',
				},
			),
		).toThrow(/must end with/);
	});

	it('extracts stored zip entries', async () => {
		const archive = buildStoredZip([
			{ name: 'summary.json', text: '{"ok":true}' },
			{ name: 'capture.jpg', text: 'fake-binary' },
		]);
		const entries = await extractZipEntries(archive.buffer);
		expect(decodeUtf8(entries.get('summary.json')!)).toBe('{"ok":true}');
		expect(decodeUtf8(entries.get('capture.jpg')!)).toBe('fake-binary');
	});
});
