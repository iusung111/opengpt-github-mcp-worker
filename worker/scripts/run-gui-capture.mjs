
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { chromium } from 'playwright';

const artifactDir = path.join(process.cwd(), 'gui-capture-artifact');
const screenshotsDir = path.join(artifactDir, 'screenshots');
const logsDir = path.join(artifactDir, 'logs');
fs.mkdirSync(screenshotsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

const instructions = JSON.parse(Buffer.from(process.env.INSTRUCTIONS_B64 || '', 'base64').toString('utf8'));
const scenario = instructions.scenario ?? { steps: [] };
const reportConfig = instructions.report ?? {};
const stepResults = [];
const findings = [];
const consoleLogs = [];
const pageErrors = [];
const networkErrors = [];
const browserChannel = typeof process.env.PLAYWRIGHT_BROWSER_CHANNEL === 'string'
  ? process.env.PLAYWRIGHT_BROWSER_CHANNEL.trim()
  : '';

function slug(value, fallback = 'step') {
  return String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function stepFileBase(index, step, suffix = '') {
  const idx = String(index + 1).padStart(2, '0');
  const name = slug(step.name || step.id || step.action || `step-${idx}`, `step-${idx}`);
  return `${idx}-${name}${suffix}`;
}

function screenshotRel(fileName) {
  return `screenshots/${fileName}`;
}

async function savePageShot(page, fileName) {
  const abs = path.join(screenshotsDir, fileName);
  await page.screenshot({ path: abs, fullPage: true });
  return screenshotRel(fileName);
}

function resolvedBaseUrl() {
  if (instructions.mode === 'html_scenario' && instructions.file_text) {
    const fileName = instructions.file_name || 'scenario.html';
    const htmlPath = path.join(artifactDir, fileName);
    fs.writeFileSync(htmlPath, instructions.file_text, 'utf8');
    return pathToFileURL(htmlPath).toString();
  }
  if (instructions.app_url) return instructions.app_url;
  if (process.env.LOCAL_HTML_URL) return process.env.LOCAL_HTML_URL;
  return null;
}

function resolveStepUrl(baseUrl, stepUrl) {
  if (!stepUrl) return baseUrl;
  try {
    return new URL(stepUrl, baseUrl || undefined).toString();
  } catch {
    return stepUrl;
  }
}

function recordFinding(severity, summary, rationale, stepIndex = null, screenshotRef = null) {
  findings.push({ severity, summary, rationale, step_index: stepIndex, screenshot_ref: screenshotRef });
}

async function executeStep(page, baseUrl, step, index) {
  const result = {
    index,
    id: step.id || `step-${index + 1}`,
    name: step.name || step.id || step.action || `step-${index + 1}`,
    action: step.action,
    status: 'passed',
    selector: step.selector ?? null,
    message: null,
    error: null,
    screenshot_before: null,
    screenshot_after: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  const captureMode = step.capture || 'after';
  try {
    if (captureMode === 'before_after') {
      result.screenshot_before = await savePageShot(page, `${stepFileBase(index, step, '-before')}.png`);
    }
    const locator = step.selector ? page.locator(step.selector) : null;
    const timeout = Number(step.timeout_ms || 5000);

    switch (step.action) {
      case 'open': {
        const target = resolveStepUrl(baseUrl, step.url);
        if (!target) throw new Error('no target url resolved for open step');
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
        result.message = `opened ${target}`;
        break;
      }
      case 'click': {
        if (!locator) throw new Error('click step requires selector');
        await locator.first().click({ timeout });
        result.message = `clicked ${step.selector}`;
        break;
      }
      case 'type': {
        if (!locator) throw new Error('type step requires selector');
        await locator.first().fill(String(step.value ?? ''), { timeout });
        result.message = `typed into ${step.selector}`;
        break;
      }
      case 'press': {
        if (locator) {
          await locator.first().press(String(step.value ?? 'Enter'), { timeout });
          result.message = `pressed ${step.value ?? 'Enter'} on ${step.selector}`;
        } else {
          await page.keyboard.press(String(step.value ?? 'Enter'));
          result.message = `pressed ${step.value ?? 'Enter'}`;
        }
        break;
      }
      case 'select': {
        if (!locator) throw new Error('select step requires selector');
        await locator.first().selectOption(String(step.value ?? ''));
        result.message = `selected ${step.value ?? ''}`;
        break;
      }
      case 'hover': {
        if (!locator) throw new Error('hover step requires selector');
        await locator.first().hover({ timeout });
        result.message = `hovered ${step.selector}`;
        break;
      }
      case 'scroll': {
        if (locator) {
          await locator.first().scrollIntoViewIfNeeded({ timeout });
          result.message = `scrolled to ${step.selector}`;
        } else {
          await page.evaluate((value) => window.scrollTo(0, Number(value || window.innerHeight)), step.value ?? null);
          result.message = 'scrolled page';
        }
        break;
      }
      case 'wait_for': {
        if (locator) {
          await locator.first().waitFor({ state: 'visible', timeout });
          result.message = `waited for ${step.selector}`;
        } else {
          await page.waitForTimeout(timeout);
          result.message = `waited ${timeout}ms`;
        }
        break;
      }
      case 'assert_visible': {
        if (!locator) throw new Error('assert_visible step requires selector');
        const visible = await locator.first().isVisible({ timeout });
        if (!visible) throw new Error(`expected ${step.selector} to be visible`);
        result.message = `${step.selector} is visible`;
        break;
      }
      case 'assert_text': {
        if (!locator) throw new Error('assert_text step requires selector');
        const actual = (await locator.first().textContent({ timeout })) ?? '';
        const expected = String(step.expected_text ?? '');
        if (!actual.includes(expected)) {
          throw new Error(`expected text "${expected}" in ${step.selector}, actual "${actual.trim()}"`);
        }
        result.message = `text matched ${step.selector}`;
        break;
      }
      case 'assert_url': {
        const actual = page.url();
        const expected = String(step.expected_value ?? step.value ?? '');
        if (!expected) throw new Error('assert_url step requires expected_value or value');
        if (!actual.includes(expected)) {
          throw new Error(`expected current URL to include "${expected}", actual "${actual}"`);
        }
        result.message = `url matched ${expected}`;
        break;
      }
      case 'assert_count': {
        if (!locator) throw new Error('assert_count step requires selector');
        const actual = await locator.count();
        const expected = Number(step.expected_count ?? 0);
        if (actual !== expected) throw new Error(`expected ${expected} matches for ${step.selector}, actual ${actual}`);
        result.message = `count matched ${step.selector}`;
        break;
      }
      case 'assert_attribute': {
        if (!locator) throw new Error('assert_attribute step requires selector');
        const attr = String(step.attribute_name ?? '');
        const actual = await locator.first().getAttribute(attr, { timeout });
        const expected = String(step.expected_value ?? '');
        if ((actual ?? '') !== expected) throw new Error(`expected ${attr}="${expected}" on ${step.selector}, actual "${actual ?? ''}"`);
        result.message = `attribute matched ${step.selector}`;
        break;
      }
      case 'screenshot':
      case 'snapshot': {
        result.message = 'captured screenshot';
        break;
      }
      default:
        throw new Error(`unsupported action: ${step.action}`);
    }

    if (
      captureMode === 'after' ||
      captureMode === 'before_after' ||
      step.action === 'screenshot' ||
      step.action === 'snapshot'
    ) {
      result.screenshot_after = await savePageShot(page, `${stepFileBase(index, step, '-after')}.png`);
    }
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    const failureRef = await savePageShot(page, `${stepFileBase(index, step, '-failed')}.png`);
    result.screenshot_after = result.screenshot_after || failureRef;
    recordFinding(
      'high',
      `Step failed: ${result.name}`,
      result.error,
      index,
      result.screenshot_after,
    );
  } finally {
    result.finished_at = new Date().toISOString();
  }
  return result;
}

function buildReport(summary) {
  const lines = [
    '# GUI capture report',
    '',
    `- Status: ${summary.result.overall_status}`,
    `- Mode: ${summary.mode}`,
    `- Target: ${summary.execution.resolved_app_url ?? 'n/a'}`,
    `- Requested steps: ${summary.result.requested_steps}`,
    `- Passed steps: ${summary.result.passed_steps}`,
    `- Failed steps: ${summary.result.failed_steps}`,
    '',
    '## Step results',
    '',
  ];
  for (const step of summary.steps) {
    lines.push(`### ${String(step.index + 1).padStart(2, '0')} ${step.name}`);
    lines.push(`- Action: ${step.action}`);
    lines.push(`- Status: ${step.status}`);
    if (step.selector) lines.push(`- Selector: ${step.selector}`);
    if (step.message) lines.push(`- Message: ${step.message}`);
    if (step.error) lines.push(`- Error: ${step.error}`);
    if (step.screenshot_before) lines.push(`- Screenshot before: ${step.screenshot_before}`);
    if (step.screenshot_after) lines.push(`- Screenshot after: ${step.screenshot_after}`);
    lines.push('');
  }

  lines.push('## Findings', '');
  if (summary.findings.length === 0) {
    lines.push('- No findings');
  } else {
    for (const finding of summary.findings) {
      lines.push(`- [${finding.severity}] ${finding.summary}`);
      lines.push(`  - Rationale: ${finding.rationale}`);
      if (finding.screenshot_ref) lines.push(`  - Evidence: ${finding.screenshot_ref}`);
    }
  }

  if (reportConfig.include_console_logs !== false) {
    lines.push('', '## Console / runtime', '');
    lines.push(`- Console entries: ${consoleLogs.length}`);
    lines.push(`- Page errors: ${pageErrors.length}`);
    lines.push(`- Network errors: ${networkErrors.length}`);
  }
  return lines.join('\n');
}

const baseUrl = resolvedBaseUrl();
let browser;
let page;
let overallStatus = 'partial';
let finalCapture = null;

try {
  if (instructions.mode === 'html_scenario' || instructions.mode === 'url_scenario') {
    if (!baseUrl) throw new Error('no base url resolved for scenario execution');
    const launchOptions = { headless: true };
    if (browserChannel) {
      launchOptions.channel = browserChannel;
    }
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: scenario.viewport || { width: 1440, height: 900 },
    });
    page = await context.newPage();

    page.on('console', (msg) => {
      consoleLogs.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (err) => {
      pageErrors.push({ message: err.message });
    });
    page.on('requestfailed', (request) => {
      networkErrors.push({
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText || 'request failed',
      });
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const result = await executeStep(page, baseUrl, step, index);
      stepResults.push(result);
      if (result.status === 'failed' && scenario.stop_on_failure !== false) break;
    }

    finalCapture = path.join(artifactDir, 'capture-final.jpg');
    await page.screenshot({ path: finalCapture, fullPage: true, type: 'jpeg' });
    overallStatus = stepResults.some((x) => x.status === 'failed') ? 'fail' : 'pass';
  } else {
    recordFinding('medium', 'Legacy analysis mode not implemented in this runner patch', 'This runner patch implements real browser execution for html/url scenario modes first.');
    overallStatus = 'partial';
  }
} catch (error) {
  overallStatus = 'fail';
  recordFinding('critical', 'Runner failed before completion', error instanceof Error ? error.message : String(error));
  if (page) {
    try {
      finalCapture = path.join(artifactDir, 'capture-final.jpg');
      await page.screenshot({ path: finalCapture, fullPage: true, type: 'jpeg' });
    } catch {}
  }
} finally {
  if (browser) await browser.close();
}

fs.writeFileSync(path.join(logsDir, 'console.json'), JSON.stringify(consoleLogs, null, 2), 'utf8');
fs.writeFileSync(path.join(logsDir, 'page-errors.json'), JSON.stringify(pageErrors, null, 2), 'utf8');
fs.writeFileSync(path.join(logsDir, 'network-errors.json'), JSON.stringify(networkErrors, null, 2), 'utf8');

const screenshotFiles = fs.existsSync(screenshotsDir)
  ? fs.readdirSync(screenshotsDir).map((name) => screenshotRel(name)).sort()
  : [];

const summary = {
  ok: overallStatus !== 'fail',
  request_id: typeof instructions.request_id === 'string' ? instructions.request_id : null,
  mode: String(instructions.mode ?? 'unknown'),
  request: {
    request_id: typeof instructions.request_id === 'string' ? instructions.request_id : null,
  },
  execution: {
    requested_app_url: instructions.app_url ?? null,
    resolved_app_url: baseUrl,
    app_source: instructions.mode === 'html_scenario' ? 'inline_html_file' : 'app_url',
    scenario_name: scenario.name ?? null,
    viewport: scenario.viewport || { width: 1440, height: 900 },
  },
  result: {
    overall_status: overallStatus,
    requested_steps: Array.isArray(scenario.steps) ? scenario.steps.length : 0,
    passed_steps: stepResults.filter((x) => x.status === 'passed').length,
    failed_steps: stepResults.filter((x) => x.status === 'failed').length,
    skipped_steps: stepResults.filter((x) => x.status === 'skipped').length,
  },
  steps: stepResults,
  findings,
  artifacts: {
    report: 'report.md',
    final_capture: fs.existsSync(path.join(artifactDir, 'capture-final.jpg')) ? 'capture-final.jpg' : null,
    screenshots: screenshotFiles,
  },
  logs: {
    console_count: consoleLogs.length,
    page_error_count: pageErrors.length,
    network_error_count: networkErrors.length,
  },
};

fs.writeFileSync(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
fs.writeFileSync(path.join(artifactDir, 'report.md'), buildReport(summary), 'utf8');
