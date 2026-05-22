/**
 * src/browser/launcher.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Detects installed browsers, launches Puppeteer, applies stealth patches.
 *
 * KEY CONCEPTS:
 *
 * puppeteer-core: Puppeteer WITHOUT a bundled browser. We always provide
 * the executablePath ourselves — either a system Chrome/Edge or the bundled
 * Chromium that puppeteer (full package) downloads.
 *
 * userDataDir: a temporary folder where Chrome stores cookies/cache for this
 * session. Using a temp dir means each run starts fresh (no leftover state).
 *
 * Stealth patches: Chrome identifies itself as "Chrome controlled by automation"
 * via navigator.webdriver=true. We hide that property so websites treat us
 * as a real user.
 */
import puppeteerCore from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import inquirer from 'inquirer';
import fs       from 'fs';
import os       from 'os';
import path     from 'path';

import { USER_AGENT } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Stealth helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injects anti-detection patches into a page BEFORE any page scripts run.
 * evaluateOnNewDocument() runs our script first, so the page can't see it happened.
 *
 * navigator.webdriver = true  → Puppeteer's default, visible to anti-bot scripts
 * navigator.webdriver = undefined → looks like a real Chrome browser
 */
export async function applyStealth(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    // Hide Puppeteer's webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Real Chrome always has languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // Real Chrome has plugins (Puppeteer has none by default)
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    // Chrome extension API — exists in real Chrome, not in headless
    (window as any).chrome = { runtime: {} };
  });
}

/**
 * Applies all configuration to a newly created page:
 * stealth patches + viewport + User-Agent + language header.
 */
export async function configPage(page: Page): Promise<void> {
  await applyStealth(page);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(USER_AGENT);
  // Tell servers we prefer English — reduces chance of language-specific blocks
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser detection
// ─────────────────────────────────────────────────────────────────────────────

/** Known installation paths per operating system */
const INSTALLED_CANDIDATES: Record<string, Array<{ name: string; path: string }>> = {
  win32: [
    { name: 'Chrome',       path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Chrome (x86)', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Edge',         path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
    { name: 'Edge (x86)',   path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  ],
  darwin: [
    { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { name: 'Edge',   path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  ],
  linux: [
    { name: 'Chrome',   path: '/usr/bin/google-chrome' },
    { name: 'Chromium', path: '/usr/bin/chromium-browser' },
    { name: 'Edge',     path: '/usr/bin/microsoft-edge' },
  ],
};

/**
 * Searches known locations where puppeteer (full package) stores Chromium.
 * Returns the binary path if found, null if not downloaded.
 *
 * This is purely synchronous — no async/await needed for filesystem checks.
 */
function findBundledChromium(): string | null {
  // These are the directories where puppeteer downloads Chromium
  const searchBases = [
    path.join(os.homedir(), '.cache', 'puppeteer', 'chrome'),
    path.join(process.cwd(), 'node_modules', 'puppeteer', '.local-chromium'),
    path.join(process.cwd(), 'node_modules', 'puppeteer', '.local-chrome'),
  ];

  for (const base of searchBases) {
    if (!fs.existsSync(base)) continue;
    // Each subfolder is a different Chrome version
    for (const sub of fs.readdirSync(base)) {
      // Try different platform-specific binary paths
      const candidates = [
        path.join(base, sub, 'chrome-win64',  'chrome.exe'),
        path.join(base, sub, 'chrome-win',    'chrome.exe'),
        path.join(base, sub, 'chrome-linux',  'chrome'),
        path.join(base, sub, 'chrome-mac',    'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p; // found it
      }
    }
  }
  return null; // not found
}

/** One entry in the browser picker list */
export interface BrowserOption {
  name:            string;
  executablePath:  string;
  headless:        boolean;
}

/**
 * Returns all usable browsers on this machine.
 * Only includes browsers whose binary file actually exists on disk.
 * Bundled Chromium is added only if the puppeteer download was not skipped.
 */
export function detectBrowsers(): BrowserOption[] {
  const list: BrowserOption[] = [];

  // Add system-installed browsers (Chrome, Edge, etc.)
  for (const c of (INSTALLED_CANDIDATES[process.platform] ?? INSTALLED_CANDIDATES.linux)) {
    if (fs.existsSync(c.path)) {
      list.push({ name: c.name, executablePath: c.path, headless: false });
    }
  }

  // Add bundled Chromium only if it was downloaded
  const bundledPath = findBundledChromium();
  if (bundledPath) {
    // unshift adds to the FRONT of the array — bundled appears first
    list.unshift({ name: 'Bundled Chromium (headless)', executablePath: bundledPath, headless: true });
  }

  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
// Launch
// ─────────────────────────────────────────────────────────────────────────────

/** Puppeteer launch flags that improve reliability and reduce bot detection */
const LAUNCH_ARGS = [
  '--no-sandbox',                               // required in some environments
  '--disable-blink-features=AutomationControlled', // hides "Chrome is controlled by automation"
  '--disable-dev-shm-usage',                    // prevents crashes in low-memory environments
];

/** Result returned from launchBrowserWithChoice */
export interface LaunchResult {
  browser:    Browser;  // the Puppeteer Browser object (manages the whole process)
  page:       Page;     // the first/main tab
  userDataDir: string;  // temp directory path (for cleanup)
  keepOpen:   boolean;  // whether to leave browser open after script finishes
  isHeadless: boolean;  // whether running without a visible window
}

/**
 * Launches a browser with the given settings.
 * Creates a temp userDataDir so this session doesn't affect your real browser.
 */
async function launchBrowser(selected: BrowserOption): Promise<LaunchResult> {
  // mkdtempSync creates a unique temp directory, e.g. /tmp/scraper-ab3c5d/
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-'));

  const browser = await puppeteerCore.launch({
    headless:       selected.headless ?? false,
    executablePath: selected.executablePath,
    userDataDir,
    args:           LAUNCH_ARGS,
  });

  const page = await browser.newPage();
  await configPage(page); // apply stealth + viewport + UA

  return { browser, page, userDataDir, keepOpen: true, isHeadless: selected.headless ?? false };
}

/**
 * Shows an interactive prompt to let the user pick a browser,
 * then launches it and returns the result.
 * priorAnswers: pre-supply answers to skip the prompt (used by UI server).
 */
export async function launchBrowserWithChoice(
  priorAnswers: { browser: string; keepOpen: boolean } | null = null,
): Promise<LaunchResult> {
  const browsers = detectBrowsers();

  if (browsers.length === 0) {
    throw new Error(
      'No usable browser found on this machine.\n\n' +
      'Options:\n' +
      '  1. Install Google Chrome or Microsoft Edge.\n' +
      '  2. Remove PUPPETEER_SKIP_DOWNLOAD from .npmrc, then run: npm install\n' +
      '     (this downloads a bundled Chromium ~170 MB)',
    );
  }

  // Use provided answers or prompt the user interactively
  const answers = priorAnswers ?? await inquirer.prompt([
    {
      type:    'list',
      name:    'browser',
      message: 'Select browser to use:',
      choices: browsers.map(b => b.name),
      default: browsers[0].name,
    },
    {
      type:    'confirm',
      name:    'keepOpen',
      message: 'Keep browser open after the script finishes?',
      default: true,
    },
  ]) as { browser: string; keepOpen: boolean };

  const selected = browsers.find(b => b.name === answers.browser)!;
  const result   = await launchBrowser(selected);
  return { ...result, keepOpen: answers.keepOpen };
}

/** Shows a "Browser closed — reopen?" prompt and relaunches if user agrees */
export async function relaunchBrowserPrompt(): Promise<LaunchResult | null> {
  const { reopen } = await inquirer.prompt([{
    type:    'confirm',
    name:    'reopen',
    message: 'Browser closed or unresponsive — reopen and continue?',
    default: true,
  }]) as { reopen: boolean };

  if (!reopen) return null;

  const browsers = detectBrowsers();
  if (browsers.length === 0) return null;

  const { browserChoice } = await inquirer.prompt([{
    type:    'list',
    name:    'browserChoice',
    message: 'Select browser to reopen:',
    choices: browsers.map(b => b.name),
    default: browsers[0].name,
  }]) as { browserChoice: string };

  return launchBrowser(browsers.find(b => b.name === browserChoice)!);
}
