export type DatasetFileType = 'csv' | 'tsv' | 'json';

export type DatasetCell = string | number | boolean | null;

export interface UploadedDataset {
	fileName: string;
	fileType: DatasetFileType;
	fileSize: number;
	columns: string[];
	rows: Record<string, DatasetCell>[];
	sampleRows: Record<string, DatasetCell>[];
	warnings: string[];
}

export type AggregateMode = 'count' | 'sum' | 'average';
export type SortMode = 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc';
export type MissingValueMode = 'exclude' | 'bucket';
export type ChartType = 'auto' | 'bar' | 'histogram';

export interface AnalysisConfig {
	targetColumn: string;
	filterText: string;
	aggregate: AggregateMode;
	sort: SortMode;
	missing: MissingValueMode;
	chartType: ChartType;
}

export interface ChartDatum {
	label: string;
	value: number;
}

export interface AnalysisResult {
	summaryMetrics: Array<{ label: string; value: string }>;
	filteredRowCount: number;
	totalRowCount: number;
	missingTargetCount: number;
	distinctTargetCount: number;
	numericTarget: boolean;
	warnings: string[];
	tableColumns: string[];
	tableRows: Record<string, DatasetCell>[];
	chartType: Exclude<ChartType, 'auto'>;
	chartData: ChartDatum[];
}

export interface CaptureSummary {
	screen: 'analysis-ready' | 'dataset-loaded' | 'idle';
	datasetName: string | null;
	datasetType: DatasetFileType | null;
	totalRows: number;
	filteredRows: number;
	targetColumn: string | null;
	aggregate: AggregateMode | null;
	sort: SortMode | null;
	missing: MissingValueMode | null;
	chartType: Exclude<ChartType, 'auto'> | null;
	warnings: string[];
	error: string | null;
	captureReady: boolean;
	generatedAt: string;
}

function normalizeCellValue(value: unknown): DatasetCell {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length === 0 ? null : trimmed;
	}
	return JSON.stringify(value);
}

function coerceNumeric(value: DatasetCell): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const numeric = Number(trimmed.replace(/,/g, ''));
	return Number.isFinite(numeric) ? numeric : null;
}

function parseSeparatedLine(line: string, delimiter: string): string[] {
	const result: string[] = [];
	let current = '';
	let inQuotes = false;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (char === '"') {
			const next = line[index + 1];
			if (inQuotes && next === '"') {
				current += '"';
				index += 1;
				continue;
			}
			inQuotes = !inQuotes;
			continue;
		}
		if (char === delimiter && !inQuotes) {
			result.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	result.push(current);
	return result.map((value) => value.trim());
}

export function detectDatasetFileType(fileName: string): DatasetFileType | null {
	const normalized = fileName.toLowerCase();
	if (normalized.endsWith('.csv')) return 'csv';
	if (normalized.endsWith('.tsv')) return 'tsv';
	if (normalized.endsWith('.json')) return 'json';
	return null;
}

export function parseDelimitedText(
	text: string,
	delimiter: string,
	fileName: string,
	fileType: DatasetFileType,
	fileSize = text.length,
): UploadedDataset {
	const normalizedText = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
	if (!normalizedText) throw new Error('empty file');
	const lines = normalizedText
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	if (lines.length === 0) throw new Error('empty file');
	const headers = parseSeparatedLine(lines[0], delimiter).map((header, index) =>
		header.length > 0 ? header : `column_${index + 1}`,
	);
	const warnings: string[] = [];
	if (headers.every((header) => header.startsWith('column_'))) {
		warnings.push('Header row was missing, so generic column names were assigned.');
	}
	const rows = lines.slice(1).map((line) => {
		const values = parseSeparatedLine(line, delimiter);
		const row: Record<string, DatasetCell> = {};
		headers.forEach((header, index) => {
			row[header] = normalizeCellValue(values[index] ?? null);
		});
		return row;
	});
	return {
		fileName,
		fileType,
		fileSize,
		columns: headers,
		rows,
		sampleRows: rows.slice(0, 5),
		warnings,
	};
}

export function parseJsonText(text: string, fileName: string, fileSize = text.length): UploadedDataset {
	const parsed = JSON.parse(text) as unknown;
	const rowSource = Array.isArray(parsed) ? parsed : [parsed];
	if (rowSource.length === 0) throw new Error('json array is empty');
	const rows = rowSource.map((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error('json rows must be objects');
		}
		const row: Record<string, DatasetCell> = {};
		for (const [key, value] of Object.entries(entry)) {
			row[key] = normalizeCellValue(value);
		}
		return row;
	});
	const columns = Array.from(
		rows.reduce((set, row) => {
			for (const key of Object.keys(row)) set.add(key);
			return set;
		}, new Set<string>()),
	);
	return {
		fileName,
		fileType: 'json',
		fileSize,
		columns,
		rows,
		sampleRows: rows.slice(0, 5),
		warnings: Array.isArray(parsed) ? [] : ['Top-level object was wrapped into a single-row dataset.'],
	};
}

export function parseDatasetText(
	text: string,
	fileName: string,
	fileType: DatasetFileType,
	fileSize = text.length,
): UploadedDataset {
	if (fileType === 'csv') return parseDelimitedText(text, ',', fileName, fileType, fileSize);
	if (fileType === 'tsv') return parseDelimitedText(text, '\t', fileName, fileType, fileSize);
	return parseJsonText(text, fileName, fileSize);
}

function buildCategoryChart(
	values: Array<{ label: string; numericValue: number | null }>,
	aggregate: AggregateMode,
	sort: SortMode,
): ChartDatum[] {
	const counts = new Map<string, number>();
	for (const item of values) {
		const current = counts.get(item.label) ?? 0;
		const increment =
			aggregate === 'count' ? 1 : aggregate === 'sum' ? item.numericValue ?? 0 : item.numericValue ?? 0;
		counts.set(item.label, current + increment);
	}
	let chartData = Array.from(counts.entries()).map(([label, value]) => ({ label, value }));
	if (aggregate === 'average') {
		const totals = new Map<string, { sum: number; count: number }>();
		for (const item of values) {
			const bucket = totals.get(item.label) ?? { sum: 0, count: 0 };
			if (item.numericValue !== null) {
				bucket.sum += item.numericValue;
				bucket.count += 1;
			}
			totals.set(item.label, bucket);
		}
		chartData = chartData.map((item) => {
			const bucket = totals.get(item.label);
			if (!bucket || bucket.count === 0) return { label: item.label, value: 0 };
			return { label: item.label, value: bucket.sum / bucket.count };
		});
	}
	const sorters: Record<SortMode, (left: ChartDatum, right: ChartDatum) => number> = {
		value_desc: (left, right) => right.value - left.value || left.label.localeCompare(right.label),
		value_asc: (left, right) => left.value - right.value || left.label.localeCompare(right.label),
		label_asc: (left, right) => left.label.localeCompare(right.label),
		label_desc: (left, right) => right.label.localeCompare(left.label),
	};
	return chartData.sort(sorters[sort]).slice(0, 12);
}

function buildHistogramChart(values: number[]): ChartDatum[] {
	if (values.length === 0) return [];
	const min = Math.min(...values);
	const max = Math.max(...values);
	const bins = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(values.length))));
	if (min === max) return [{ label: `${min}`, value: values.length }];
	const size = (max - min) / bins || 1;
	const buckets = Array.from({ length: bins }, (_, index) => ({
		label: `${(min + size * index).toFixed(2)} - ${(min + size * (index + 1)).toFixed(2)}`,
		value: 0,
	}));
	for (const value of values) {
		const rawIndex = Math.floor((value - min) / size);
		const index = Math.max(0, Math.min(bins - 1, rawIndex));
		buckets[index].value += 1;
	}
	return buckets;
}

export function analyzeDataset(dataset: UploadedDataset, config: AnalysisConfig): AnalysisResult {
	const targetColumn = config.targetColumn || dataset.columns[0];
	const warnings = [...dataset.warnings];
	if (!targetColumn) {
		return {
			summaryMetrics: [],
			filteredRowCount: 0,
			totalRowCount: dataset.rows.length,
			missingTargetCount: dataset.rows.length,
			distinctTargetCount: 0,
			numericTarget: false,
			warnings: ['No target column is available for analysis.'],
			tableColumns: dataset.columns,
			tableRows: [],
			chartType: 'bar',
			chartData: [],
		};
	}
	const filterText = config.filterText.trim().toLowerCase();
	const filteredRows = dataset.rows.filter((row) => {
		if (!filterText) return true;
		return dataset.columns.some((column) => String(row[column] ?? '').toLowerCase().includes(filterText));
	});
	const values = filteredRows.map((row) => normalizeCellValue(row[targetColumn] ?? null));
	const missingTargetCount = values.filter((value) => value === null || value === '').length;
	const cleanedValues = values.flatMap((value) => {
		if (value === null || value === '') return config.missing === 'bucket' ? ['(missing)'] : [];
		return [String(value)];
	});
	const numericValues = values.map((value) => coerceNumeric(value)).filter((value): value is number => value !== null);
	const numericTarget = numericValues.length > 0 && numericValues.length >= Math.ceil(values.length / 2);
	if (!numericTarget && config.aggregate !== 'count') {
		warnings.push('Selected aggregate needs numeric values; falling back to categorical counts where needed.');
	}
	const categoryInputs = values.flatMap((value) => {
		if (value === null || value === '') {
			return config.missing === 'bucket' ? [{ label: '(missing)', numericValue: null }] : [];
		}
		return [{ label: String(value), numericValue: coerceNumeric(value) }];
	});
	const chartType = config.chartType === 'auto' ? (numericTarget ? 'histogram' : 'bar') : config.chartType;
	const chartData =
		chartType === 'histogram'
			? buildHistogramChart(numericValues)
			: buildCategoryChart(categoryInputs, config.aggregate, config.sort);
	const numericAverage =
		numericValues.length > 0
			? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
			: null;
	return {
		summaryMetrics: [
			{ label: 'Rows', value: `${filteredRows.length} / ${dataset.rows.length}` },
			{ label: 'Target', value: targetColumn },
			{ label: 'Distinct', value: `${new Set(cleanedValues).size}` },
			{ label: 'Missing', value: `${missingTargetCount}` },
			{ label: 'Numeric avg', value: numericAverage === null ? 'n/a' : numericAverage.toFixed(2) },
		],
		filteredRowCount: filteredRows.length,
		totalRowCount: dataset.rows.length,
		missingTargetCount,
		distinctTargetCount: new Set(cleanedValues).size,
		numericTarget,
		warnings,
		tableColumns: dataset.columns,
		tableRows: filteredRows.slice(0, 12),
		chartType,
		chartData,
	};
}

export function createDefaultAnalysisConfig(dataset: UploadedDataset): AnalysisConfig {
	return {
		targetColumn: dataset.columns[0] ?? '',
		filterText: '',
		aggregate: 'count',
		sort: 'value_desc',
		missing: 'exclude',
		chartType: 'auto',
	};
}

export function createCaptureSummary(
	dataset: UploadedDataset | null,
	config: AnalysisConfig | null,
	result: AnalysisResult | null,
	error: string | null,
): CaptureSummary {
	return {
		screen: result ? 'analysis-ready' : dataset ? 'dataset-loaded' : 'idle',
		datasetName: dataset?.fileName ?? null,
		datasetType: dataset?.fileType ?? null,
		totalRows: result?.totalRowCount ?? dataset?.rows.length ?? 0,
		filteredRows: result?.filteredRowCount ?? dataset?.rows.length ?? 0,
		targetColumn: config?.targetColumn ?? null,
		aggregate: config?.aggregate ?? null,
		sort: config?.sort ?? null,
		missing: config?.missing ?? null,
		chartType: result?.chartType ?? null,
		warnings: result?.warnings ?? dataset?.warnings ?? [],
		error,
		captureReady: Boolean(dataset && result && !error),
		generatedAt: new Date().toISOString(),
	};
}
