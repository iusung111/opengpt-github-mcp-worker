(function () {
	'use strict';

	const STORAGE_KEY = 'offline-gui-analysis-settings';
	const STORAGE_ENABLED_KEY = 'offline-gui-analysis-settings-enabled';

	function detectFileType(fileName) {
		const normalized = String(fileName || '').toLowerCase();
		if (normalized.endsWith('.csv')) return 'csv';
		if (normalized.endsWith('.tsv')) return 'tsv';
		if (normalized.endsWith('.json')) return 'json';
		return null;
	}

	function normalizeCellValue(value) {
		if (value === null || value === undefined) return null;
		if (typeof value === 'number' || typeof value === 'boolean') return value;
		const text = String(value).trim();
		return text.length === 0 ? null : text;
	}

	function toNumber(value) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value !== 'string') return null;
		const numeric = Number(value.replace(/,/g, '').trim());
		return Number.isFinite(numeric) ? numeric : null;
	}

	function parseSeparatedLine(line, delimiter) {
		const result = [];
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

	function parseDelimitedText(text, delimiter, fileName, fileType, fileSize) {
		const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
		if (!normalized) throw new Error('The selected file is empty.');
		const lines = normalized
			.split('\n')
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);
		if (!lines.length) throw new Error('The selected file is empty.');
		const headers = parseSeparatedLine(lines[0], delimiter).map((header, index) =>
			header.length ? header : `column_${index + 1}`,
		);
		const warnings = [];
		if (headers.every((header) => header.startsWith('column_'))) {
			warnings.push('Header row was missing, so generic column names were assigned.');
		}
		const rows = lines.slice(1).map((line) => {
			const values = parseSeparatedLine(line, delimiter);
			const row = {};
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

	function parseJsonText(text, fileName, fileSize) {
		const parsed = JSON.parse(text);
		const source = Array.isArray(parsed) ? parsed : [parsed];
		if (!source.length) throw new Error('JSON array is empty.');
		const rows = source.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				throw new Error('JSON rows must be objects.');
			}
			const row = {};
			Object.entries(entry).forEach(([key, value]) => {
				row[key] = normalizeCellValue(value);
			});
			return row;
		});
		const columnSet = new Set();
		rows.forEach((row) => Object.keys(row).forEach((column) => columnSet.add(column)));
		return {
			fileName,
			fileType: 'json',
			fileSize,
			columns: Array.from(columnSet),
			rows,
			sampleRows: rows.slice(0, 5),
			warnings: Array.isArray(parsed) ? [] : ['Top-level object was wrapped into a single-row dataset.'],
		};
	}

	function parseDatasetText(text, fileName, fileType, fileSize) {
		if (fileType === 'csv') return parseDelimitedText(text, ',', fileName, fileType, fileSize);
		if (fileType === 'tsv') return parseDelimitedText(text, '\t', fileName, fileType, fileSize);
		return parseJsonText(text, fileName, fileSize);
	}

	function createDefaultConfig(dataset) {
		return {
			targetColumn: dataset.columns[0] || '',
			filterText: '',
			aggregate: 'count',
			sort: 'value_desc',
			missing: 'exclude',
			chartType: 'auto',
		};
	}

	function buildCategoryChart(values, aggregate, sort) {
		const counts = new Map();
		values.forEach((item) => {
			const current = counts.get(item.label) || 0;
			const increment =
				aggregate === 'count'
					? 1
					: aggregate === 'sum'
						? item.numericValue || 0
						: item.numericValue || 0;
			counts.set(item.label, current + increment);
		});
		let chartData = Array.from(counts.entries()).map(([label, value]) => ({ label, value }));
		if (aggregate === 'average') {
			const totals = new Map();
			values.forEach((item) => {
				const bucket = totals.get(item.label) || { sum: 0, count: 0 };
				if (item.numericValue !== null) {
					bucket.sum += item.numericValue;
					bucket.count += 1;
				}
				totals.set(item.label, bucket);
			});
			chartData = chartData.map((item) => {
				const bucket = totals.get(item.label);
				if (!bucket || bucket.count === 0) return { label: item.label, value: 0 };
				return { label: item.label, value: bucket.sum / bucket.count };
			});
		}
		const sorters = {
			value_desc: (left, right) => right.value - left.value || left.label.localeCompare(right.label),
			value_asc: (left, right) => left.value - right.value || left.label.localeCompare(right.label),
			label_asc: (left, right) => left.label.localeCompare(right.label),
			label_desc: (left, right) => right.label.localeCompare(left.label),
		};
		return chartData.sort(sorters[sort]).slice(0, 12);
	}

	function buildHistogram(values) {
		if (!values.length) return [];
		const min = Math.min.apply(null, values);
		const max = Math.max.apply(null, values);
		const bins = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(values.length))));
		if (min === max) return [{ label: String(min), value: values.length }];
		const size = (max - min) / bins || 1;
		const buckets = Array.from({ length: bins }, function (_, index) {
			return {
				label: `${(min + size * index).toFixed(2)} - ${(min + size * (index + 1)).toFixed(2)}`,
				value: 0,
			};
		});
		values.forEach((value) => {
			const rawIndex = Math.floor((value - min) / size);
			const index = Math.max(0, Math.min(bins - 1, rawIndex));
			buckets[index].value += 1;
		});
		return buckets;
	}

	function analyzeDataset(dataset, config) {
		const targetColumn = config.targetColumn || dataset.columns[0];
		const warnings = dataset.warnings.slice();
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
		const numericValues = values.map(toNumber).filter((value) => value !== null);
		const numericTarget = numericValues.length > 0 && numericValues.length >= Math.ceil(values.length / 2);
		if (!numericTarget && config.aggregate !== 'count') {
			warnings.push('Selected aggregate needs numeric values; falling back to categorical counts where needed.');
		}
		const categoryInputs = values.flatMap((value) => {
			if (value === null || value === '') {
				return config.missing === 'bucket' ? [{ label: '(missing)', numericValue: null }] : [];
			}
			return [{ label: String(value), numericValue: toNumber(value) }];
		});
		const chartType = config.chartType === 'auto' ? (numericTarget ? 'histogram' : 'bar') : config.chartType;
		const chartData =
			chartType === 'histogram'
				? buildHistogram(numericValues)
				: buildCategoryChart(categoryInputs, config.aggregate, config.sort);
		const distinctTargetCount = new Set(
			values.flatMap((value) => {
				if (value === null || value === '') return config.missing === 'bucket' ? ['(missing)'] : [];
				return [String(value)];
			}),
		).size;
		const numericAverage = numericValues.length
			? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
			: null;
		return {
			summaryMetrics: [
				{ label: 'Rows', value: `${filteredRows.length} / ${dataset.rows.length}` },
				{ label: 'Target', value: targetColumn },
				{ label: 'Distinct', value: String(distinctTargetCount) },
				{ label: 'Missing', value: String(missingTargetCount) },
				{ label: 'Numeric avg', value: numericAverage === null ? 'n/a' : numericAverage.toFixed(2) },
			],
			filteredRowCount: filteredRows.length,
			totalRowCount: dataset.rows.length,
			missingTargetCount,
			distinctTargetCount,
			numericTarget,
			warnings,
			tableColumns: dataset.columns,
			tableRows: filteredRows.slice(0, 12),
			chartType,
			chartData,
		};
	}

	function createCaptureSummary(dataset, config, result, error) {
		return {
			screen: result ? 'analysis-ready' : dataset ? 'dataset-loaded' : 'idle',
			datasetName: dataset ? dataset.fileName : null,
			datasetType: dataset ? dataset.fileType : null,
			totalRows: result ? result.totalRowCount : dataset ? dataset.rows.length : 0,
			filteredRows: result ? result.filteredRowCount : dataset ? dataset.rows.length : 0,
			targetColumn: config ? config.targetColumn : null,
			aggregate: config ? config.aggregate : null,
			sort: config ? config.sort : null,
			missing: config ? config.missing : null,
			chartType: result ? result.chartType : null,
			warnings: result ? result.warnings : dataset ? dataset.warnings : [],
			error,
			captureReady: Boolean(dataset && result && !error),
			generatedAt: new Date().toISOString(),
		};
	}

	const elements = {
		fileInput: document.getElementById('file-input'),
		dropZone: document.getElementById('drop-zone'),
		readProgress: document.getElementById('read-progress'),
		uploadStatusText: document.getElementById('upload-status-text'),
		fileError: document.getElementById('file-error'),
		rowCount: document.getElementById('row-count'),
		columnCount: document.getElementById('column-count'),
		warningCount: document.getElementById('warning-count'),
		datasetTypePill: document.getElementById('dataset-type-pill'),
		datasetSizePill: document.getElementById('dataset-size-pill'),
		columnList: document.getElementById('column-list'),
		previewTableHead: document.querySelector('#preview-table thead'),
		previewTableBody: document.querySelector('#preview-table tbody'),
		previewWarningBanner: document.getElementById('preview-warning-banner'),
		targetColumn: document.getElementById('target-column'),
		aggregateMode: document.getElementById('aggregate-mode'),
		sortMode: document.getElementById('sort-mode'),
		missingMode: document.getElementById('missing-mode'),
		chartType: document.getElementById('chart-type'),
		filterText: document.getElementById('filter-text'),
		persistToggle: document.getElementById('persist-toggle'),
		resultCards: document.getElementById('result-cards'),
		resultsWarningBanner: document.getElementById('results-warning-banner'),
		resultsTableHead: document.querySelector('#results-table thead'),
		resultsTableBody: document.querySelector('#results-table tbody'),
		chartArea: document.getElementById('chart-area'),
		chartModeLabel: document.getElementById('chart-mode-label'),
		captureReadyPill: document.getElementById('capture-ready-pill'),
		captureDatasetName: document.getElementById('capture-dataset-name'),
		captureTargetColumn: document.getElementById('capture-target-column'),
		captureRowSummary: document.getElementById('capture-row-summary'),
		captureJson: document.getElementById('capture-json'),
		analysisSummary: document.getElementById('analysis-summary'),
		resetSession: document.getElementById('reset-session'),
	};

	const state = {
		dataset: null,
		config: null,
		result: null,
		error: null,
	};

	function setBanner(element, message) {
		element.textContent = message || '';
		element.classList.toggle('hidden', !message);
	}

	function formatBytes(size) {
		if (!size) return '0 bytes';
		if (size < 1024) return `${size} bytes`;
		if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
		return `${(size / (1024 * 1024)).toFixed(2)} MB`;
	}

	function escapeHtml(value) {
		return String(value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function renderTable(thead, tbody, columns, rows) {
		if (!columns.length) {
			thead.innerHTML = '';
			tbody.innerHTML = '<tr><td class="muted">No data loaded.</td></tr>';
			return;
		}
		thead.innerHTML = `<tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr>`;
		if (!rows.length) {
			tbody.innerHTML = `<tr><td colspan="${columns.length}" class="muted">No rows to display.</td></tr>`;
			return;
		}
		tbody.innerHTML = rows
			.map(
				(row) =>
					`<tr>${columns
						.map((column) => `<td>${escapeHtml(row[column] === null || row[column] === undefined ? '' : row[column])}</td>`)
						.join('')}</tr>`,
			)
			.join('');
	}

	function renderPreview() {
		const dataset = state.dataset;
		elements.rowCount.textContent = dataset ? String(dataset.rows.length) : '0';
		elements.columnCount.textContent = dataset ? String(dataset.columns.length) : '0';
		elements.warningCount.textContent = dataset ? String(dataset.warnings.length) : '0';
		elements.datasetTypePill.textContent = dataset ? dataset.fileType.toUpperCase() : 'No dataset';
		elements.datasetSizePill.textContent = dataset ? formatBytes(dataset.fileSize) : '0 bytes';
		elements.columnList.innerHTML = dataset
			? dataset.columns.map((column) => `<li>${escapeHtml(column)}</li>`).join('')
			: '';
		renderTable(
			elements.previewTableHead,
			elements.previewTableBody,
			dataset ? dataset.columns : [],
			dataset ? dataset.sampleRows : [],
		);
		setBanner(elements.previewWarningBanner, dataset && dataset.warnings.length ? dataset.warnings.join(' ') : '');
	}

	function renderResultCards(summaryMetrics) {
		elements.resultCards.innerHTML = summaryMetrics
			.map((metric) => `<div class="stat-card"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong></div>`)
			.join('');
	}

	function renderChart(result) {
		if (!result || !result.chartData.length) {
			elements.chartArea.innerHTML = '<div class="chart-empty">Load a dataset to render a chart.</div>';
			elements.chartModeLabel.textContent = 'No chart';
			return;
		}
		elements.chartModeLabel.textContent = result.chartType === 'histogram' ? 'Histogram' : 'Bar';
		const maxValue = Math.max.apply(
			null,
			result.chartData.map((item) => item.value).concat([1]),
		);
		if (result.chartType === 'histogram') {
			elements.chartArea.innerHTML = `<div class="histogram">${result.chartData
				.map((item) => {
					const height = Math.max(12, (item.value / maxValue) * 180);
					return `<div class="histogram-bar"><div class="histogram-bar-fill" style="height:${height}px"></div><span class="histogram-value">${escapeHtml(item.value)}</span><span class="histogram-label">${escapeHtml(item.label)}</span></div>`;
				})
				.join('')}</div>`;
			return;
		}
		elements.chartArea.innerHTML = `<div class="bar-list">${result.chartData
			.map((item) => {
				const width = Math.max(6, (item.value / maxValue) * 100);
				return `<div class="bar-row"><span>${escapeHtml(item.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div><strong>${escapeHtml(item.value.toFixed(2).replace(/\.00$/, ''))}</strong></div>`;
			})
			.join('')}</div>`;
	}

	function persistConfig() {
		if (!elements.persistToggle.checked || !state.config) return;
		localStorage.setItem(STORAGE_ENABLED_KEY, 'true');
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
	}

	function syncFormFromConfig() {
		if (!state.config) return;
		elements.targetColumn.value = state.config.targetColumn;
		elements.aggregateMode.value = state.config.aggregate;
		elements.sortMode.value = state.config.sort;
		elements.missingMode.value = state.config.missing;
		elements.chartType.value = state.config.chartType;
		elements.filterText.value = state.config.filterText;
	}

	function syncConfigFromForm() {
		if (!state.dataset) return;
		state.config = {
			targetColumn: elements.targetColumn.value,
			aggregate: elements.aggregateMode.value,
			sort: elements.sortMode.value,
			missing: elements.missingMode.value,
			chartType: elements.chartType.value,
			filterText: elements.filterText.value,
		};
		persistConfig();
	}

	function updateCaptureSummary() {
		const summary = createCaptureSummary(state.dataset, state.config, state.result, state.error);
		const summaryText = JSON.stringify(summary, null, 2);
		elements.analysisSummary.textContent = summaryText;
		elements.captureJson.textContent = summaryText;
		elements.captureReadyPill.textContent = summary.captureReady ? 'Capture ready' : 'Not ready';
		elements.captureReadyPill.classList.toggle('danger', !summary.captureReady);
		elements.captureDatasetName.textContent = summary.datasetName || 'none';
		elements.captureTargetColumn.textContent = summary.targetColumn || 'none';
		elements.captureRowSummary.textContent = `${summary.filteredRows} / ${summary.totalRows}`;
	}

	function renderResults() {
		const result = state.result;
		renderResultCards(result ? result.summaryMetrics : []);
		renderChart(result);
		renderTable(
			elements.resultsTableHead,
			elements.resultsTableBody,
			result ? result.tableColumns : [],
			result ? result.tableRows : [],
		);
		setBanner(elements.resultsWarningBanner, result && result.warnings.length ? result.warnings.join(' ') : '');
		updateCaptureSummary();
	}

	function applyAnalysis() {
		if (!state.dataset) {
			state.result = null;
			renderResults();
			return;
		}
		syncConfigFromForm();
		state.result = analyzeDataset(state.dataset, state.config);
		renderResults();
	}

	function populateColumnOptions(dataset) {
		elements.targetColumn.innerHTML = dataset.columns
			.map((column) => `<option value="${escapeHtml(column)}">${escapeHtml(column)}</option>`)
			.join('');
	}

	function loadPersistedConfig(dataset) {
		const enabled = localStorage.getItem(STORAGE_ENABLED_KEY) === 'true';
		elements.persistToggle.checked = enabled;
		if (!enabled) return createDefaultConfig(dataset);
		try {
			const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
			return {
				...createDefaultConfig(dataset),
				...parsed,
				targetColumn: dataset.columns.includes(parsed.targetColumn) ? parsed.targetColumn : dataset.columns[0] || '',
			};
		} catch {
			return createDefaultConfig(dataset);
		}
	}

	function resetSession() {
		state.dataset = null;
		state.config = null;
		state.result = null;
		state.error = null;
		elements.fileInput.value = '';
		elements.readProgress.value = 0;
		elements.uploadStatusText.textContent = 'No file loaded.';
		setBanner(elements.fileError, '');
		renderPreview();
		renderResults();
	}

	function handleDatasetLoaded(dataset) {
		state.dataset = dataset;
		state.error = null;
		setBanner(elements.fileError, '');
		elements.uploadStatusText.textContent = `${dataset.fileName} loaded successfully.`;
		populateColumnOptions(dataset);
		state.config = loadPersistedConfig(dataset);
		syncFormFromConfig();
		renderPreview();
		applyAnalysis();
	}

	function readFileWithProgress(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onprogress = function (event) {
				if (event.lengthComputable) {
					elements.readProgress.value = Math.round((event.loaded / event.total) * 100);
				}
			};
			reader.onerror = function () {
				reject(reader.error || new Error('File read failed.'));
			};
			reader.onload = function () {
				resolve(String(reader.result || ''));
			};
			reader.readAsText(file);
		});
	}

	async function handleFile(file) {
		const fileType = detectFileType(file.name);
		if (!fileType) {
			state.error = 'Unsupported file type. Choose a CSV, TSV, or JSON file.';
			setBanner(elements.fileError, state.error);
			updateCaptureSummary();
			return;
		}
		elements.readProgress.value = 0;
		elements.uploadStatusText.textContent = `Reading ${file.name}...`;
		try {
			const text = await readFileWithProgress(file);
			const dataset = parseDatasetText(text, file.name, fileType, file.size);
			handleDatasetLoaded(dataset);
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			setBanner(elements.fileError, state.error);
			state.result = null;
			updateCaptureSummary();
		}
	}

	['change', 'input'].forEach((eventName) => {
		['targetColumn', 'aggregateMode', 'sortMode', 'missingMode', 'chartType', 'filterText'].forEach((key) => {
			elements[key].addEventListener(eventName, applyAnalysis);
		});
	});

	elements.persistToggle.addEventListener('change', function () {
		if (elements.persistToggle.checked) {
			persistConfig();
			return;
		}
		localStorage.removeItem(STORAGE_KEY);
		localStorage.setItem(STORAGE_ENABLED_KEY, 'false');
	});

	elements.fileInput.addEventListener('change', function (event) {
		const file = event.target.files && event.target.files[0];
		if (file) handleFile(file);
	});

	elements.dropZone.addEventListener('dragover', function (event) {
		event.preventDefault();
	});

	elements.dropZone.addEventListener('drop', function (event) {
		event.preventDefault();
		const file = event.dataTransfer.files && event.dataTransfer.files[0];
		if (file) handleFile(file);
	});

	elements.dropZone.addEventListener('keydown', function (event) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			elements.fileInput.click();
		}
	});

	elements.resetSession.addEventListener('click', resetSession);

	elements.persistToggle.checked = localStorage.getItem(STORAGE_ENABLED_KEY) === 'true';
	resetSession();
})();
