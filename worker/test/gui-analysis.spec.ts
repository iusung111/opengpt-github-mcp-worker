import { describe, expect, it } from 'vitest';

import {
	analyzeDataset,
	createCaptureSummary,
	createDefaultAnalysisConfig,
	detectDatasetFileType,
	parseDatasetText,
	parseDelimitedText,
	parseJsonText,
} from '../src/gui-analysis';

describe('gui analysis helpers', () => {
	it('detects supported file types', () => {
		expect(detectDatasetFileType('report.csv')).toBe('csv');
		expect(detectDatasetFileType('report.tsv')).toBe('tsv');
		expect(detectDatasetFileType('report.json')).toBe('json');
		expect(detectDatasetFileType('report.xlsx')).toBeNull();
	});

	it('parses csv text into rows and columns', () => {
		const dataset = parseDelimitedText('name,value\nalpha,1\nbeta,2', ',', 'sample.csv', 'csv');
		expect(dataset.columns).toEqual(['name', 'value']);
		expect(dataset.rows).toHaveLength(2);
		expect(dataset.rows[1]).toEqual({ name: 'beta', value: '2' });
	});

	it('parses json arrays and wrapped objects', () => {
		const arrayDataset = parseJsonText('[{"name":"alpha","value":1}]', 'sample.json');
		expect(arrayDataset.columns).toEqual(['name', 'value']);
		const objectDataset = parseJsonText('{"name":"solo","value":3}', 'single.json');
		expect(objectDataset.rows).toHaveLength(1);
		expect(objectDataset.warnings[0]).toMatch(/wrapped/);
	});

	it('throws for empty inputs', () => {
		expect(() => parseDatasetText('', 'empty.csv', 'csv')).toThrow(/empty file/);
		expect(() => parseJsonText('[]', 'empty.json')).toThrow(/empty/);
	});

	it('analyzes categorical data with missing buckets', () => {
		const dataset = parseDelimitedText(
			'team,score\nred,10\nblue,\nred,12\ngreen,8',
			',',
			'sample.csv',
			'csv',
		);
		const result = analyzeDataset(dataset, {
			targetColumn: 'team',
			filterText: '',
			aggregate: 'count',
			sort: 'value_desc',
			missing: 'bucket',
			chartType: 'bar',
		});
		expect(result.filteredRowCount).toBe(4);
		expect(result.chartData[0]).toMatchObject({ label: 'red', value: 2 });
		expect(result.summaryMetrics[0]).toMatchObject({ label: 'Rows', value: '4 / 4' });
	});

	it('builds histogram data for numeric targets', () => {
		const dataset = parseDelimitedText('value\n1\n2\n3\n4\n5\n6\n7\n8', ',', 'numbers.csv', 'csv');
		const config = createDefaultAnalysisConfig(dataset);
		const result = analyzeDataset(dataset, config);
		expect(result.chartType).toBe('histogram');
		expect(result.numericTarget).toBe(true);
		expect(result.chartData.length).toBeGreaterThan(1);
	});

	it('creates capture summaries for automation', () => {
		const dataset = parseDelimitedText('status\nopen\nclosed', ',', 'sample.csv', 'csv');
		const config = createDefaultAnalysisConfig(dataset);
		const result = analyzeDataset(dataset, config);
		const summary = createCaptureSummary(dataset, config, result, null);
		expect(summary.captureReady).toBe(true);
		expect(summary.datasetName).toBe('sample.csv');
		expect(summary.targetColumn).toBe('status');
		expect(summary.screen).toBe('analysis-ready');
	});
});
