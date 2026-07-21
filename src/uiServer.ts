/**
 * src/uiServer.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * SIGINT Admin Server  —  http://localhost:3001
 *
 * ARCHITECTURE OVERVIEW:
 *   This is the single-file Express 5 backend for the SIGINT admin interface.
 *   Express 5 is used because async route handlers automatically forward thrown
 *   errors to the error handler — no more try/catch boilerplate in every route.
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  Browser (admin UI)                                                 │
 *   │    └─ http://localhost:3001  ←─── Express 5 (this file)            │
 *   │         ├─ /api/browser/*   ←── Puppeteer browser management       │
 *   │         ├─ /api/scrape      ←── Job queue + platform dispatchers   │
 *   │         ├─ /api/stream/:id  ←── Server-Sent Events (live log)      │
 *   │         └─ /api/ticker/*    ←── Ticker store + Supabase sync       │
 *   │                                                                     │
 *   │  sigint-silk.vercel.app  ←── polls Supabase directly (no tunnel)  │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * KEY DESIGN DECISIONS:
 *   • Serial job queue: only one scrape runs at a time (scrapers share one
 *     browser page — parallel jobs would fight over it).
 *   • Console interception: all console.log/error calls are forwarded to the
 *     active job's SSE stream so the browser log mirrors the terminal exactly.
 *   • Persistent profiles: each platform stores login cookies in a dedicated
 *     folder (.profile-instagram/, etc.) so users only log in once.
 *   • Supabase sync: every ticker push is written to Supabase so the public
 *     Vercel-hosted ticker works even when the local server is offline.
 */

// ── Node.js built-ins ─────────────────────────────────────────────────────────
import path            from 'path';
import { fileURLToPath } from 'url';
import { randomUUID }  from 'crypto';
import fs              from 'fs';
import os              from 'os';
import { execSync }    from 'node:child_process';

// ── Third-party dependencies ──────────────────────────────────────────────────
import express         from 'express';
import puppeteerCore   from 'puppeteer-core';
import ExcelJS         from 'exceljs';

// ── Internal modules ──────────────────────────────────────────────────────────
import { USER_AGENT, CONFIG }                           from './config.js';
import { requireAuth, ADMIN_USER, ADMIN_PASS, createSession, destroySession, setSessionCookie, clearSessionCookie } from './auth.js';
import { detectBrowsers as _detectBrowsers, type BrowserOption } from './browser/launcher.js';

// Scrapers
import { scrapeYoutubeSearch }                         from './scraper/youtube/search.js';
import { scrapeYoutubeComments }                       from './scraper/youtube/comments.js';
import { scrapeYoutubeChannelSearch }                  from './scraper/youtube/channel-search.js';
import { scrapeChannelVideos }                         from './scraper/youtube/channel-videos.js';
import { scrapeProfileOnPage }                         from './scraper/orchestrator.js';
import { searchRedditPosts, searchRedditSubreddits }   from './scraper/reddit/search.js';
import { scrapeSubreddit }                             from './scraper/reddit/subreddit.js';
import { scrapePostComments }                          from './scraper/reddit/post-comments.js';
import { resetRedditSession }                          from './scraper/reddit/api.js';
import { searchXPosts, scrapeXProfile, scrapeXThread, ensureXLogin } from './scraper/x/index.js';

// Excel exporters
import { appendSearchResults, appendVideoComments, appendChannelSearchResults, appendChannelVideos, saveSearchWorkbook, saveCommentsWorkbook, saveChannelSearchWorkbook, saveChannelVideosWorkbook } from './output/youtube-excel.js';
import { appendPostSearchResults, appendSubredditSearchResults, appendSubredditPosts, appendPostComments as appendRedditComments } from './output/reddit-excel.js';
import { appendXTweets }                               from './output/x-excel.js';
import { exportProfileToWorkbookAppend }               from './output/excel.js';
import { addYouTubeSearchDashboard, addYouTubeCommentsDashboard, addChannelSearchDashboard, addChannelVideosDashboard, addInstagramDashboard, addRedditDashboard } from './output/dashboard.js';

// Utilities
import { ensureDir }                                   from './utils/fs.js';
import { startDisplayServer, publishToDisplay, normaliseResults } from './displayServer.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3001;

/** Chromium launch flags common to all browsers */
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-popup-blocking',
];

/**
 * Persistent profile directories — one per platform.
 * Storing login cookies here means users only need to log in once per platform;
 * credentials survive server restarts.
 */
const PROFILE_DIRS: Record<string, string> = {
  youtube:   path.join(process.cwd(), '.profile-youtube'),
  reddit:    path.join(process.cwd(), '.profile-reddit'),
  instagram: path.join(process.cwd(), '.profile-instagram'),
  x:         path.join(process.cwd(), '.profile-x'),
  linkedin:  path.join(process.cwd(), '.profile-linkedin'),
};

/**
 * Login page URLs — where the browser navigates when the user clicks
 * "Visible + Login" for a platform.
 */
const LOGIN_URLS: Record<string, string> = {
  youtube:   'https://accounts.google.com/signin',
  reddit:    'https://www.reddit.com/login',
  instagram: 'https://www.instagram.com/accounts/login/',
  x:         'https://x.com/i/flow/login',
  linkedin:  'https://www.linkedin.com/login',
};

/**
 * URL substrings that indicate a successful login for each platform.
 * Used by /api/browser/confirm-login to verify the user has logged in.
 */
const LOGGED_IN_PATTERNS: Record<string, string[]> = {
  youtube:   ['myaccount.google.com', 'youtube.com/feed'],
  reddit:    ['reddit.com/'],
  instagram: ['instagram.com/'],
  x:         ['x.com/home', 'x.com/feed'],
  linkedin:  ['linkedin.com/feed', 'linkedin.com/in/'],
};

// ── Process-level crash guards ────────────────────────────────────────────────
// Without these, ANY unhandled error kills Node.js and takes the browser with it.
// These handlers log the error but keep the server alive.

process.on('uncaughtException',  (err: Error)    => origError(`[CRASH GUARD] Uncaught: ${err.message}`));
process.on('unhandledRejection', (r: unknown)    => origError(`[CRASH GUARD] Rejection: ${r instanceof Error ? r.message : r}`));

// ── Browser state ─────────────────────────────────────────────────────────────

/** The single shared Puppeteer browser instance. Only one may run at a time. */
let sharedBrowser:  any    = null;
let sharedPage:     any    = null;
let sharedUserData: string | null = null;  // temp dir to clean up on close
let isHeadless:     boolean = true;

// ─────────────────────────────────────────────────────────────────────────────
// Browser detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scans the filesystem for installed browsers.
 * Returns a list ordered: Bundled Chromium first, then installed browsers
 * in this priority: Chrome → Edge → Brave → Opera GX → Opera → Vivaldi → Firefox.
 *
 * WHY SCAN PATHS?: Puppeteer can only control browsers it knows the exact
 * executable path for. We check every known installation directory on Windows,
 * macOS, and Linux. The user's dropdown in the UI is built from this list.
 */
export function findBrowsers(): BrowserOption[] {
  const seen = new Set<string>();
  const list: BrowserOption[] = [];

  /**
   * Adds a browser to the list if the executable exists and hasn't been added yet.
   * @param name     Display name shown in the dropdown
   * @param exe      Absolute path to the browser executable
   * @param headless Whether this browser runs without a visible window (only true for bundled Chromium)
   */
  const add = (name: string, exe: string, headless = false) => {
    if (!seen.has(exe) && fs.existsSync(exe)) {
      seen.add(exe);
      list.push({ name, executablePath: exe, headless });
    }
  };

  // Bundled Puppeteer Chromium — always available, always headless
  const bundled = _detectBrowsers().find(b => b.headless);
  if (bundled) list.push(bundled);

  if (process.platform === 'win32') {
    // Windows: browsers install to Program Files or LocalAppData
    const pf   = process.env['ProgramFiles']      ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const lad  = process.env['LOCALAPPDATA']       ?? '';
    add('Chrome',    `${pf}\\Google\\Chrome\\Application\\chrome.exe`);
    add('Chrome',    `${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
    add('Chrome',    `${lad}\\Google\\Chrome\\Application\\chrome.exe`);
    add('Edge',      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
    add('Edge',      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`);
    add('Brave',     `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`);
    add('Brave',     `${pf86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`);
    add('Opera GX',  `${lad}\\Programs\\Opera GX\\opera.exe`);
    add('Opera',     `${lad}\\Programs\\Opera\\opera.exe`);
    add('Vivaldi',   `${lad}\\Vivaldi\\Application\\vivaldi.exe`);
    add('Firefox',   `${pf}\\Mozilla Firefox\\firefox.exe`);
    add('Firefox',   `${pf86}\\Mozilla Firefox\\firefox.exe`);
  } else if (process.platform === 'darwin') {
    add('Chrome',   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('Edge',     '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('Brave',    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    add('Firefox',  '/Applications/Firefox.app/Contents/MacOS/firefox');
    add('Opera',    '/Applications/Opera.app/Contents/MacOS/Opera');
    add('Vivaldi',  '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi');
  } else {
    // Linux: use `which` to find browsers in PATH
    ['google-chrome','google-chrome-stable','chromium-browser','chromium','microsoft-edge','brave-browser','firefox'].forEach(bin => {
      try { const p = execSync(`which ${bin}`, { stdio: ['pipe','pipe','pipe'] }).toString().trim(); if (p) add(bin, p); } catch {}
    });
  }

  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser launch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the correct Puppeteer launch arguments for the given browser.
 *
 * WHY DIFFERENT ARGS PER BROWSER?
 *   Edge has a "Renderer Code Integrity" security feature that blocks external
 *   process injection (exactly how Puppeteer controls the browser). The
 *   --disable-features=RendererCodeIntegrity flag disables only that check.
 *   Chrome/Brave need --disable-blink-features=AutomationControlled to hide
 *   the "browser is controlled by automation" banner from websites.
 */
function getBrowserArgs(browserName: string): string[] {
  const name = (browserName ?? '').toLowerCase();
  if (name.includes('edge')) {
    return [...BASE_ARGS, '--disable-features=RendererCodeIntegrity'];
  }
  return [...BASE_ARGS, '--disable-blink-features=AutomationControlled'];
}

/**
 * Launches a Puppeteer-controlled browser and sets it as the shared instance.
 *
 * @param browserName  Name from findBrowsers() — must match exactly
 * @param headless     true = invisible (fast), false = visible window (for login)
 * @param platform     If provided, use the persistent profile dir for this platform
 *
 * PERSISTENT PROFILES:
 *   When platform is set, userDataDir points to .profile-{platform}/ which
 *   persists between launches. This keeps login cookies alive across restarts.
 *   Without it, a fresh temp dir is used and cleared on close.
 *
 * FALLBACK ON LOCK:
 *   If the profile dir is locked (another browser instance already using it),
 *   we automatically retry with a fresh temp dir. This happens when Edge is
 *   already running as the user's main browser.
 */
async function launchBrowser(
  browserName: string,
  headless = true,
  platform = '',
): Promise<{ name: string; headless: boolean }> {

  const list     = findBrowsers();
  const selected = list.find(b => b.name === browserName) ?? list.find(b => !b.headless) ?? list[0];
  if (!selected) throw new Error('No browser found. Install Chrome, Edge, or Brave.');

  // Choose user data directory
  let ud: string;
  if (platform && PROFILE_DIRS[platform]) {
    ud = PROFILE_DIRS[platform];
    if (!fs.existsSync(ud)) fs.mkdirSync(ud, { recursive: true });
    origLog(`  ✓  Using persistent ${platform} profile: ${ud}`);
  } else {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'sigint-browser-'));
  }

  // Login always requires a visible browser — override headless=true if platform is set
  const useHeadless = platform ? false : headless;
  const launchArgs  = getBrowserArgs(selected.name);
  origLog(`  Launching ${selected.name} (${useHeadless ? 'headless' : 'visible'}) with ${launchArgs.length} args`);

  const opts = {
    headless: useHeadless,
    executablePath: selected.executablePath,
    userDataDir: ud,
    args: launchArgs,
    timeout: 30_000,
  };

  try {
    sharedBrowser = await puppeteerCore.launch(opts);
  } catch (firstErr: any) {
    // Profile dir may be locked (e.g. Edge already running with it)
    origLog(`  ⚠  Profile launch failed: ${firstErr.message.slice(0, 100)}`);
    origLog(`  ↻  Retrying with temp profile…`);
    const tempUd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigint-retry-'));
    try {
      sharedBrowser = await puppeteerCore.launch({ ...opts, userDataDir: tempUd });
      sharedUserData = tempUd;
      origLog('  ✓  Launched with temp profile (session will not persist)');
    } catch (secondErr: any) {
      throw new Error(
        `Cannot launch ${selected.name}. ` +
        `Try: 1) Close all ${selected.name} windows, ` +
        `2) Run terminal as Administrator, ` +
        `3) Use a different browser. ` +
        `Details: ${secondErr.message.slice(0, 120)}`
      );
    }
  }

  // Configure the new page with stealth settings
  sharedPage = await sharedBrowser.newPage();
  await sharedPage.evaluateOnNewDocument(() => {
    // Hide automation indicators that websites use to detect bots
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    (window as any).chrome = { runtime: {} };
  });
  await sharedPage.setViewport({ width: 1366, height: 900 });
  await sharedPage.setUserAgent(USER_AGENT);
  await sharedPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Only clean up temp dirs, never persistent profile dirs
  sharedUserData = platform ? null : ud;
  isHeadless     = useHeadless;

  return { name: selected.name, headless: useHeadless };
}

/**
 * Closes the browser and cleans up temp profile directories.
 * Always safe to call even if no browser is open.
 */
async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = sharedPage = null;
    if (sharedUserData) {
      fs.rmSync(sharedUserData, { recursive: true, force: true });
      sharedUserData = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens `count` browser pages for parallel scraping.
 * The first slot always reuses sharedPage to preserve login state.
 * Additional slots open new pages in the same browser context (same cookies).
 */
async function openPages(count: number): Promise<any[]> {
  const pages = [sharedPage];
  for (let i = 1; i < count; i++) {
    const p = await sharedBrowser.newPage();
    await p.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as any).chrome = { runtime: {} };
    });
    await p.setViewport({ width: 1366, height: 900 });
    await p.setUserAgent(USER_AGENT);
    await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    pages.push(p);
  }
  return pages;
}

/** Closes all pages except the main shared page (index 0). */
async function closeExtraPages(pages: any[]): Promise<void> {
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }
}

/**
 * Processes `items` through `fn(item, page)` with up to `n` concurrent workers.
 *
 * WHY THIS PATTERN?
 *   Opening multiple browser tabs and assigning one item per tab lets us scrape
 *   in parallel. We chunk the work: chunk size = n workers, process each chunk
 *   in parallel, then move to the next chunk.
 *
 * @param items    Array of inputs (keywords, URLs, usernames…)
 * @param fn       Async function: (item, page) → result
 * @param n        Max concurrent workers (capped at 10)
 * @param logJobId If provided, logs chunk start messages to the job's SSE stream
 */
async function runConcurrent<T>(
  items:     string[],
  fn:        (item: string, page: any) => Promise<T>,
  n:         number,
  logJobId?: string,
): Promise<T[]> {
  if (!items.length) return [];
  const safeN  = Math.max(1, Math.min(n, 10, items.length));
  const pages  = await openPages(safeN);
  const results: T[] = [];
  try {
    for (let i = 0; i < items.length; i += safeN) {
      const chunk = items.slice(i, i + safeN);
      if (logJobId && chunk.length > 1) {
        emitLog(logJobId, `  ⚡ ${chunk.length} parallel workers — chunk ${Math.floor(i / safeN) + 1}`);
      }
      const chunkResults = await Promise.all(
        chunk.map((item, idx) =>
          fn(item, pages[idx % safeN]).catch(err => {
            origError(`Worker error for "${item}":`, err.message);
            return null as unknown as T;
          })
        )
      );
      results.push(...chunkResults.filter(r => r !== null));
    }
  } finally {
    await closeExtraPages(pages);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job queue & state
// ─────────────────────────────────────────────────────────────────────────────

/** Map of all jobs (completed or running) keyed by UUID. */
const jobs    = new Map<string, any>(); // { status, logs, results, exportData, error, params, startedAt }

/** Map of SSE response objects for each job, used to stream logs to the browser. */
const streams = new Map<string, Set<any>>();

/**
 * Serial job queue — ensures only one scrape runs at a time.
 *
 * WHY SERIAL?
 *   All scrapers share a single browser page (sharedPage). Running two jobs
 *   in parallel would cause them to navigate each other's page, producing
 *   garbage results. Jobs are queued and executed one after another.
 */
const jobQueue: string[] = [];
let   jobRunning = false;

async function drainQueue(): Promise<void> {
  if (jobRunning || jobQueue.length === 0) return;
  jobRunning = true;
  const jobId = jobQueue.shift()!;
  const job   = jobs.get(jobId);
  if (job) {
    try      { await runScrapeJob(jobId, job.params); }
    catch (e: any) { job.status = 'error'; job.error = e.message; }
  }
  jobRunning = false;
  setImmediate(drainQueue); // process next job if any
}

// ─────────────────────────────────────────────────────────────────────────────
// Console interception — mirrors terminal output to the browser live log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keep references to the original console methods so we can call them
 * after forwarding to SSE — otherwise our override would call itself.
 */
const origLog   = console.log.bind(console);
const origError = console.error.bind(console);

/** The job whose SSE stream receives console output. Set during runScrapeJob. */
let activeJob: string | null = null;

/** Safely converts any value to a loggable string — handles circular references. */
function safeStr(a: any): string {
  if (a === null || a === undefined) return String(a);
  if (typeof a !== 'object') return String(a);
  try { return JSON.stringify(a); }
  catch { return `[${a?.constructor?.name ?? 'Object'}]`; }
}

/**
 * Appends a log entry to a job's in-memory log buffer AND pushes it
 * to all currently-connected SSE clients watching that job.
 *
 * Entry format: { t: timestamp_ms, type: 'log'|'error'|'done'|'warn', line: string }
 */
function emitLog(jobId: string, line: any, type = 'log'): void {
  const job = jobs.get(jobId);
  if (!job) return;
  const entry = { t: Date.now(), type, line: String(line).slice(0, 2000) };
  job.logs.push(entry);
  // Cap log buffer at 2000 entries to prevent memory bloat during long scrapes
  if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
  const sseSet = streams.get(jobId);
  if (!sseSet) return;
  const msg = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseSet) { try { res.write(msg); } catch {} }
}

// Override console methods to forward output to the active job's SSE stream
console.log = (...args: any[]) => {
  origLog(...args);
  if (activeJob) emitLog(activeJob, args.map(safeStr).join(' '), 'log');
};
console.error = (...args: any[]) => {
  origError(...args);
  if (activeJob) emitLog(activeJob, args.map(safeStr).join(' '), 'error');
};

// ─────────────────────────────────────────────────────────────────────────────
// Scrape dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a scrape job identified by jobId.
 * Called by drainQueue() — never call directly (bypasses the queue).
 *
 * FLOW:
 *   1. Validate browser is open
 *   2. Dispatch to platform-specific scraper(s)
 *   3. Store results in job.results + job.exportData
 *   4. Emit 'done' or 'error' SSE event to close client streams
 *
 * @param jobId  UUID of the job (must exist in `jobs` Map)
 * @param params Body of the original POST /api/scrape request
 */
async function runScrapeJob(jobId: string, params: any): Promise<void> {
  const job  = jobs.get(jobId);
  job.status = 'running';
  activeJob  = jobId;

  // exportData accumulates everything needed to build the Excel workbook
  job.exportData = { platform: params.platform, mode: params.mode, items: [] };

  try {
    if (!sharedBrowser || !sharedPage) {
      throw new Error('No browser open — launch one from the Browser panel first.');
    }

    const { platform, mode, inputs, limit, filter } = params;
    const lc          = { mode: limit?.mode ?? 'all', count: limit?.count ?? null };
    const concurrency = Math.max(1, Math.min(parseInt(params.concurrency ?? '1'), 10));
    const results: any[] = [];

    if (concurrency > 1) emitLog(jobId, `⚡ ${concurrency} parallel workers`, 'log');

    // ── YouTube ──────────────────────────────────────────────────────────────
    if (platform === 'youtube') {
      if (mode === 'search') {
        // Search for videos matching each keyword
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw, page) => {
          const rows = await scrapeYoutubeSearch(page, kw, lc, filter ?? null);
          job.exportData.items.push({ type: 'search', data: rows });
          return rows;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));

      } else if (mode === 'channel-search') {
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw, page) => {
          const rows = await scrapeYoutubeChannelSearch(page, kw, lc, filter ?? null);
          job.exportData.items.push({ type: 'channel-search', data: rows });
          return rows;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));

      } else if (mode === 'channel-videos') {
        // Channel scraping is sequential — YouTube consent injection conflicts with parallel tabs
        for (const url of (inputs.urls ?? [])) {
          const { meta, videos } = await scrapeChannelVideos(sharedPage, url, lc, filter ?? null);
          results.push(...videos);
          job.exportData.items.push({ type: 'channel-videos', meta, data: videos });
        }

      } else if (mode === 'comments') {
        const batches = await runConcurrent(inputs.urls ?? [], async (url, page) => {
          const { meta, comments } = await scrapeYoutubeComments(page, url, lc);
          job.exportData.items.push({ type: 'comments', meta, data: comments });
          return comments;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));
      }
    }

    // ── Reddit ────────────────────────────────────────────────────────────────
    else if (platform === 'reddit') {
      resetRedditSession(); // clear any cached session state before each run
      if (mode === 'search-posts') {
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw, page) => {
          const rows = await searchRedditPosts(page, kw, lc, inputs.sort ?? 'relevance', inputs.time ?? 'all');
          job.exportData.items.push({ type: 'reddit-posts', data: rows });
          return rows;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));

      } else if (mode === 'search-subs') {
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw, page) => {
          const rows = await searchRedditSubreddits(page, kw, lc);
          job.exportData.items.push({ type: 'reddit-subs', data: rows });
          return rows;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));

      } else if (mode === 'subreddit') {
        const batches = await runConcurrent(inputs.subs ?? [], async (s, page) => {
          const { meta, posts } = await scrapeSubreddit(page, s, lc, inputs.sort ?? 'hot', inputs.time ?? 'all');
          job.exportData.items.push({ type: 'reddit-subreddit', meta, data: posts });
          return posts;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));

      } else if (mode === 'post-comments') {
        const batches = await runConcurrent(inputs.urls ?? [], async (url, page) => {
          const { post, comments } = await scrapePostComments(page, url, lc);
          job.exportData.items.push({ type: 'reddit-comments', post, data: comments });
          return comments;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));
      }
    }

    // ── X / Twitter ───────────────────────────────────────────────────────────
    else if (platform === 'x') {
      // X requires login for virtually all content since 2023
      const loggedIn = await ensureXLogin(sharedPage, isHeadless);
      if (!loggedIn) emitLog(jobId, '⚠  X login required. Use "Login X/Twitter" in the Browser panel.', 'warn');

      if (mode === 'search') {
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw, page) => {
          const rows = await searchXPosts(page, kw, lc, inputs.filterKey ?? 'top');
          job.exportData.items.push({ type: 'x-tweets', data: rows });
          return rows;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));

      } else if (mode === 'profile') {
        const handles = inputs.handles?.length ? inputs.handles : (inputs.keywords ?? []);
        const batches = await runConcurrent(handles, async (h: string, page: any) => {
          const { meta, tweets } = await scrapeXProfile(page, h, lc);
          job.exportData.items.push({ type: 'x-tweets', data: tweets });
          return tweets;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));

      } else if (mode === 'thread') {
        const batches = await runConcurrent(inputs.urls ?? [], async (url, page) => {
          const replies = await scrapeXThread(page, url, lc);
          job.exportData.items.push({ type: 'x-tweets', data: replies });
          return replies;
        }, concurrency, jobId);
        batches.forEach(r => results.push(...r));
      }
    }

    // ── Instagram ─────────────────────────────────────────────────────────────
    else if (platform === 'instagram') {
      const imagesDir = path.join(process.cwd(), CONFIG.instagram.imagesDirName);
      ensureDir(imagesDir);

      if (mode === 'search') {
        // Instagram search uses DOM grid scraping — no API interception needed
        const { scrapeInstagramSearch } = await import('./scraper/instagram-search.js');
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw: string, page: any) => {
          const posts = await scrapeInstagramSearch(page, kw, lc);
          job.exportData.items.push({ type: 'instagram-search', keyword: kw, data: posts });
          return posts;
        }, 1 /* always sequential for Instagram */, jobId);
        batches.forEach((r: any[]) => results.push(...r));

      } else {
        // Profile mode — scrape posts, stories, summary for each username
        const batches = await runConcurrent(inputs.usernames ?? [], async (username, page) => {
          const { summary, posts, stories } = await scrapeProfileOnPage(page, username, lc);
          job.exportData.items.push({ type: 'instagram-profile', username, summary, posts, stories });
          return { username, summary, posts, stories };
        }, Math.min(concurrency, CONFIG.instagram.parallelTabs), jobId);
        results.push(...batches);
      }
    }

    // ── LinkedIn ──────────────────────────────────────────────────────────────
    else if (platform === 'linkedin') {
      // LinkedIn requires login — persistent profile in .profile-linkedin/
      if (mode === 'feed-search') {
        // @ts-ignore — resolved at runtime
        const { scrapeLinkedInFeed } = await import('./scraper/linkedin/feed-search.js' as any);
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw: string, page: any) => {
          const posts = await scrapeLinkedInFeed(page, kw, lc);
          job.exportData.items.push({ type: 'linkedin-feed', data: posts });
          return posts;
        }, 1, jobId);
        batches.forEach((r: any[]) => results.push(...r));

      } else if (mode === 'job-search') {
        // @ts-ignore — resolved at runtime
        const { scrapeLinkedInJobs } = await import('./scraper/linkedin/job-search.js' as any);
        const batches = await runConcurrent(inputs.keywords ?? [], async (kw: string, page: any) => {
          const jobs_ = await scrapeLinkedInJobs(page, kw, inputs.location ?? '', lc);
          job.exportData.items.push({ type: 'linkedin-jobs', data: jobs_ });
          return jobs_;
        }, 1, jobId);
        batches.forEach((r: any[]) => results.push(...r));
      }
    }

    // ── Finish ────────────────────────────────────────────────────────────────
    job.results = results;
    job.status  = 'done';
    emitLog(jobId, `✅ Done — ${results.length} result(s)`, 'done');

  } catch (err: any) {
    job.error  = err.message;
    job.status = 'error';
    emitLog(jobId, `❌ Error: ${err.message}`, 'error');
    origError('Job error:', err);

  } finally {
    activeJob = null;
    // Send the terminal SSE event so clients close their EventSource connections
    const sseSet = streams.get(jobId);
    if (sseSet) {
      const msg = `data: ${JSON.stringify({ type: 'end', status: job.status })}\n\n`;
      for (const res of sseSet) { try { res.write(msg); res.end(); } catch {} }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Excel workbook builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds an ExcelJS workbook from a completed job's exportData.
 * Each item type maps to a specific sheet-building function from output/*.ts.
 */
async function buildWorkbook(exportData: any): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const { platform, mode, items } = exportData;

  for (const item of items) {
    if      (item.type === 'search')          appendSearchResults(wb, item.data);
    else if (item.type === 'channel-search')  appendChannelSearchResults(wb, item.data);
    else if (item.type === 'channel-videos')  appendChannelVideos(wb, item.meta, item.data);
    else if (item.type === 'comments')        appendVideoComments(wb, item.meta, item.data);
    else if (item.type === 'reddit-posts')    appendPostSearchResults(wb, item.data);
    else if (item.type === 'reddit-subs')     appendSubredditSearchResults(wb, item.data);
    else if (item.type === 'reddit-subreddit') appendSubredditPosts(wb, item.meta, item.data);
    else if (item.type === 'reddit-comments') appendRedditComments(wb, item.post, item.data);
    else if (item.type === 'x-tweets')        appendXTweets(wb, item.data);
    else if (item.type === 'instagram-profile') {
      const imagesDir = path.join(process.cwd(), CONFIG.instagram.imagesDirName);
      ensureDir(imagesDir);
      await exportProfileToWorkbookAppend(wb, item.username, item.summary, item.posts, item.stories, imagesDir, sharedPage);
    }
    // linkedin-feed and linkedin-jobs: basic sheet (reuse search results format)
    else if (item.type === 'linkedin-feed' || item.type === 'linkedin-jobs') {
      const sheet = wb.addWorksheet(item.type === 'linkedin-jobs' ? 'Jobs' : 'Feed');
      if (item.data?.length) {
        sheet.columns = Object.keys(item.data[0]).map(k => ({ header: k, key: k, width: 30 }));
        item.data.forEach((row: any) => sheet.addRow(row));
      }
    }
  }

  // Add platform-specific dashboard sheet
  try {
    if (platform === 'youtube') {
      if      (mode === 'search')         addYouTubeSearchDashboard(wb);
      else if (mode === 'channel-search') addChannelSearchDashboard(wb);
      else if (mode === 'channel-videos') addChannelVideosDashboard(wb);
      else if (mode === 'comments')       addYouTubeCommentsDashboard(wb);
    } else if (platform === 'reddit') {
      const modeMap: Record<string, string> = {
        'search-posts': 'post-search', 'search-subs': 'sub-search',
        'subreddit': 'subreddit',      'post-comments': 'post-comments',
      };
      addRedditDashboard(wb, modeMap[mode] ?? 'post-search');
    } else if (platform === 'instagram') {
      addInstagramDashboard(wb);
    }
  } catch (e: any) {
    origError('Dashboard generation error:', e.message);
  }

  return wb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supabase project credentials.
 * These are safe to commit — they are the "anon" (public read) key,
 * not a secret service-role key. RLS policies control what anonymous
 * clients can actually do (read-only for public, write for anon ticker push).
 */
const SUPABASE_URL      = 'https://qqmidswgsqmimxrlyqru.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxbWlkc3dnc3FtaW14cmx5cXJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2NTU3MTgsImV4cCI6MjA5NTIzMTcxOH0.UDgz4TfVM7t4jLNA-IKB8C1SVhuJj_jKXac6PApo544';

/**
 * Pushes ticker data to Supabase so the public Vercel-hosted ticker can
 * read it directly — no Cloudflare tunnel needed, works even when the
 * local server is offline.
 *
 * Uses PATCH on row id=1 (always exists). Fire-and-forget — we never await
 * this from the push endpoint so it doesn't block the HTTP response.
 */
async function syncToSupabase(store: typeof tickerStore): Promise<void> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ticker_store?id=eq.1`, {
      method:  'PATCH',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify({ data: store, updated_at: new Date().toISOString() }),
    });
    if (r.ok) {
      const total = store?.sections?.reduce((a, s) => a + s.items.length, 0) ?? 0;
      origLog(`  ✓  Supabase synced — ${store?.sections?.length ?? 0} section(s), ${total} records`);
    } else {
      origError(`  ✗  Supabase sync failed: HTTP ${r.status}`);
    }
  } catch (e: any) {
    origError(`  ✗  Supabase sync error: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticker store (disk persistence)
// ─────────────────────────────────────────────────────────────────────────────

const TICKER_FILE = path.join(process.cwd(), 'ticker-store.json');

/** Load ticker data from disk on server startup. Returns null if no data exists yet. */
function loadTickerStore(): typeof tickerStore {
  try {
    if (fs.existsSync(TICKER_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TICKER_FILE, 'utf-8'));
      origLog(`  ✓  Ticker store loaded from disk (${parsed.sections?.length ?? 0} section(s), pushed ${new Date(parsed.pushedAt).toLocaleString()})`);
      return parsed;
    }
  } catch (e: any) {
    origLog(`  ⚠  Could not load ticker store: ${e.message}`);
  }
  return null;
}

/** Persist ticker data to disk so it survives server restarts. */
function saveTickerStore(store: typeof tickerStore): void {
  try { fs.writeFileSync(TICKER_FILE, JSON.stringify(store, null, 2), 'utf-8'); }
  catch (e: any) { origError(`Could not save ticker store: ${e.message}`); }
}

let tickerStore: {
  pushedAt: number;
  sections: Array<{ platform: string; mode: string; items: unknown[] }>;
} | null = loadTickerStore();

// ─────────────────────────────────────────────────────────────────────────────
// Express 5 application
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express 5 key differences from Express 4:
 *   - Async route handlers: errors thrown inside async routes are automatically
 *     forwarded to the error handler — no try/catch needed.
 *   - app.router removed (use express.Router())
 *   - res.redirect() requires an absolute URL
 */
const app = express();

app.use(express.json({ limit: '10mb' }));

// Allow the Vercel ticker (and any other origin) to fetch /api/ticker/data
app.use((req: any, res: any, next: any) => {
  if (req.path === '/api/ticker/data') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
  }
  next();
});

// Auth middleware — protects all routes except the public ones listed in auth.ts
app.use(requireAuth);

// Serve the login page (requireAuth already exempts /login from auth check)
app.get('/login', (_req: any, res: any) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ── Auth routes ───────────────────────────────────────────────────────────────

/** POST /api/auth/login — validate credentials, set session cookie */
app.post('/api/auth/login', (req: any, res: any) => {
  const { user, pass } = req.body as { user: string; pass: string };
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const sessionId = createSession(user);
    setSessionCookie(res, sessionId);
    origLog(`Admin login: ${user} from ${req.ip}`);
    res.json({ ok: true });
  } else {
    origLog(`Failed login: "${user}" from ${req.ip}`);
    res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }
});

/** POST /api/auth/logout — destroy session, clear cookie */
app.post('/api/auth/logout', (req: any, res: any) => {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (sid) destroySession(decodeURIComponent(sid));
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** GET /api/auth/status — the UI polls this to detect session expiry */
app.get('/api/auth/status', (_req: any, res: any) => {
  res.json({ ok: true });
});

// Serve static files from public/ (index.html, login.html, ticker.html, etc.)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Health ────────────────────────────────────────────────────────────────────

/** GET /api/health — admin UI polls this every 5s to detect server crashes */
app.get('/api/health', (_req: any, res: any) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true, ts: Date.now(),
    uptime: Math.floor(process.uptime()),
    jobs: jobs.size, activeJob,
    memMb: Math.round(mem.rss / 1024 / 1024),
    browser: !!sharedBrowser,
  });
});

// ── Admin control ─────────────────────────────────────────────────────────────

app.post('/api/admin/cancel-job', (req: any, res: any) => {
  if (!activeJob) { res.json({ ok: false, msg: 'No job running.' }); return; }
  const job = jobs.get(activeJob);
  if (job) {
    job.status = 'error'; job.error = 'Cancelled by admin.';
    emitLog(activeJob, '⚠ Job cancelled.', 'warn');
    const sseSet = streams.get(activeJob);
    if (sseSet) {
      const msg = `data: ${JSON.stringify({ type: 'end', status: 'error' })}\n\n`;
      for (const r of sseSet) { try { r.write(msg); r.end(); } catch {} }
    }
  }
  activeJob = null;
  res.json({ ok: true, msg: 'Job cancelled.' });
});

app.post('/api/admin/clear-jobs', (_req: any, res: any) => {
  if (activeJob) { res.json({ ok: false, msg: 'Cannot clear while job is running.' }); return; }
  const count = jobs.size;
  jobs.clear(); streams.clear();
  res.json({ ok: true, cleared: count });
});

app.post('/api/admin/close-browser-reset', async (_req: any, res: any) => {
  await closeBrowser();
  res.json({ ok: true, msg: 'Browser closed and session reset.' });
});

// ── Browser management routes ─────────────────────────────────────────────────

app.get('/api/browser/status', (_req: any, res: any) => {
  res.json({ open: !!sharedBrowser, headless: isHeadless, browsers: findBrowsers().map(b => b.name) });
});

app.post('/api/browser/launch', async (req: any, res: any) => {
  if (sharedBrowser) await closeBrowser();
  const { browserName, headless = true, platform = '' } = req.body as {
    browserName?: string; headless?: boolean; platform?: string;
  };
  const info = await launchBrowser(browserName ?? findBrowsers()[0]?.name, headless, platform);
  res.json({ ok: true, ...info });
});

/**
 * POST /api/browser/goto-login
 * Navigates the open browser to a platform's login page.
 * The user then logs in manually in the visible window.
 */
app.post('/api/browser/goto-login', async (req: any, res: any) => {
  const { platform } = req.body as { platform: string };
  const url = LOGIN_URLS[platform];
  if (!url)        { res.status(400).json({ ok: false, error: 'Unknown platform' }); return; }
  if (!sharedPage) { res.status(400).json({ ok: false, error: 'No browser open' });  return; }
  await sharedPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
  origLog(`  ✓  Navigated to ${platform} login page`);
  res.json({ ok: true, url });
});

/**
 * POST /api/browser/confirm-login
 * Checks the current page URL to verify the user has successfully logged in.
 */
app.post('/api/browser/confirm-login', async (req: any, res: any) => {
  const { platform } = req.body as { platform: string };
  if (!sharedPage) { res.status(400).json({ ok: false, error: 'No browser open' }); return; }
  const currentUrl = sharedPage.url();
  const patterns   = LOGGED_IN_PATTERNS[platform] ?? [];
  const loggedIn   = patterns.length === 0 || patterns.some(p => currentUrl.includes(p));
  origLog(`  ${loggedIn ? '✓' : '⚠'}  ${platform} login check: ${currentUrl}`);
  res.json({ ok: true, loggedIn, url: currentUrl });
});

/** POST /api/browser/clear-profile — delete saved login cookies for a platform */
app.post('/api/browser/clear-profile', async (req: any, res: any) => {
  const { platform } = req.body as { platform: string };
  const dir = PROFILE_DIRS[platform];
  if (!dir) { res.status(400).json({ ok: false, error: 'Unknown platform' }); return; }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  origLog(`  ✓  Cleared ${platform} saved session`);
  res.json({ ok: true, msg: `${platform} session cleared.` });
});

app.post('/api/browser/close', async (_req: any, res: any) => {
  await closeBrowser();
  res.json({ ok: true });
});

// ── Job routes ────────────────────────────────────────────────────────────────

/**
 * POST /api/scrape — create and enqueue a scrape job.
 * Returns the jobId immediately; actual scraping happens asynchronously via the queue.
 */
app.post('/api/scrape', (req: any, res: any) => {
  const jobId = randomUUID();
  jobs.set(jobId, {
    id: jobId, status: 'queued', logs: [], results: [],
    exportData: null, error: null, params: req.body, startedAt: Date.now(),
  });
  streams.set(jobId, new Set());
  res.json({ jobId });
  jobQueue.push(jobId);
  setImmediate(drainQueue);
});

/**
 * GET /api/stream/:jobId — Server-Sent Events endpoint.
 * The browser connects here to receive live log lines as they are emitted.
 * Late-joining clients get all existing logs replayed immediately.
 */
app.get('/api/stream/:jobId', (req: any, res: any) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).end(); return; }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering if proxied

  res.flushHeaders();

  // Replay existing logs so late-joining clients see the full history
  for (const e of job.logs) res.write(`data: ${JSON.stringify(e)}\n\n`);

  // If already finished, send terminal event and close
  if (job.status === 'done' || job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'end', status: job.status })}\n\n`);
    res.end(); return;
  }

  streams.get(req.params.jobId)!.add(res);
  req.on('close', () => streams.get(req.params.jobId)?.delete(res));

  // Heartbeat every 15s — prevents proxy/firewall timeouts on long scrapes
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); }
  }, 15_000);
  req.on('close', () => clearInterval(heartbeat));
});

app.get('/api/results/:jobId', (req: any, res: any) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ status: job.status, results: job.results, error: job.error, count: job.results.length });
});

app.get('/api/jobs', (_req: any, res: any) => {
  res.json([...jobs.values()].map(j => ({
    id: j.id, status: j.status, startedAt: j.startedAt,
    count: j.results.length, error: j.error,
    platform: j.params?.platform, mode: j.params?.mode,
  })).reverse().slice(0, 30));
});

// ── Export ────────────────────────────────────────────────────────────────────

/** GET /api/export/:jobId — download completed job as .xlsx */
app.get('/api/export/:jobId', async (req: any, res: any) => {
  const job = jobs.get(req.params.jobId);
  if (!job)                           { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status !== 'done')          { res.status(400).json({ error: 'Job not complete' }); return; }
  if (!job.exportData?.items?.length) { res.status(400).json({ error: 'No data to export' }); return; }

  const wb    = await buildWorkbook(job.exportData);
  const buf   = await wb.xlsx.writeBuffer();
  const fname = `sigint_${job.params?.platform}_${job.params?.mode}_${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(Buffer.from(buf));
});

// ── Publish to display feed (port 3002) ───────────────────────────────────────

app.post('/api/publish', (req: any, res: any): void => {
  const { jobId, count = 20 } = req.body as { jobId: string; count: number };
  const job = jobs.get(jobId);
  if (!job)               { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status !== 'done') { res.status(400).json({ error: 'Job not complete' }); return; }
  const sections = normaliseResults(job.params?.platform, job.params?.mode, job.results, Number(count));
  publishToDisplay(sections);
  res.json({ ok: true, published: sections.reduce((a, s) => a + s.rows.length, 0) });
});

// ── Ticker routes ─────────────────────────────────────────────────────────────

/** GET /api/ticker/data — polled by the public ticker page every 3–5 seconds */
/** DELETE /api/ticker/clear — wipe all ticker data from memory, disk and Supabase */
app.post('/api/ticker/clear', (_req: any, res: any): void => {
  tickerStore = null;
  try { fs.writeFileSync(TICKER_FILE, JSON.stringify(null), 'utf-8'); } catch {}
  // Also clear in Supabase
  syncToSupabase({ pushedAt: Date.now(), sections: [] } as any);
  origLog('  ✓  Ticker cleared — all sections wiped');
  res.json({ ok: true });
});

app.get('/api/ticker/data', (_req: any, res: any): void => {
  if (!tickerStore) { res.status(204).end(); return; }
  res.json(tickerStore);
});

/**
 * POST /api/ticker/push — admin clicks "Push to Ticker"
 *
 * MERGE LOGIC:
 *   Same platform+mode → REPLACE that section (fresh search replaces old one)
 *   Different platform or mode → ADD alongside existing sections
 *
 * After updating tickerStore:
 *   1. Save to disk (ticker-store.json) for restart persistence
 *   2. Sync to Supabase (fire-and-forget) for the public Vercel ticker
 *   3. Push to the port-3002 display server for local display
 */
app.post('/api/ticker/push', (req: any, res: any): void => {
  const { jobId, limit } = req.body as { jobId: string; limit: number };
  const job = jobs.get(jobId);

  if (!job)               { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status !== 'done') { res.status(400).json({ error: 'Job not complete' }); return; }
  if (!job.exportData?.items?.length) { res.status(400).json({ error: 'No data' }); return; }

  const n        = Math.max(1, Math.min(parseInt(String(limit ?? 20)), 500));
  const platform = job.exportData.platform;
  const mode     = job.exportData.mode;
  const key      = `${platform}::${mode}`;

  // Flatten all items from this job into a single array of ticker records
  const newItems: unknown[] = [];
  for (const item of job.exportData.items) {
    const it = item as any;
    if (Array.isArray(it.data)) {
      // YouTube/Reddit/X/LinkedIn: items already in { data: [...] } format
      // Add capturedAt timestamp to each item (when pushed to SIGINT)
      const now = Date.now();
      newItems.push(...it.data.map((item: any) => ({ ...item, capturedAt: now })));
    } else if (it.type === 'instagram-profile') {
      // Instagram profile: flatten posts, enrich with profile metadata
      const posts = Array.isArray(it.posts) ? it.posts : [];
      posts.forEach((p: any) => newItems.push({
        ...p,
        author:      it.username,
        username:    it.username,
        followers:   it.summary?.followers,
        // Prefer any available text; fall back to engagement stats as content
        description: p.description || p.caption || p.text
          || (p.likes ? `♥ ${p.likes}${p.commentsCount ? '  💬 ' + p.commentsCount : ''}` : ''),
        url:         p.url || (p.shortcode ? `https://www.instagram.com/p/${p.shortcode}/` : ''),
        capturedAt:  Date.now(),  // when pushed to SIGINT
      }));
      if (posts.length === 0 && it.summary) {
        newItems.push({ ...it.summary, author: it.username, username: it.username, capturedAt: Date.now() });
      }
    } else if (it.username && it.summary) {
      newItems.push({ ...it.summary, author: it.username, username: it.username, capturedAt: Date.now() });
    }
  }

  const newSection = { platform, mode, items: newItems.slice(0, n) };
  const existing   = tickerStore?.sections ?? [];
  const merged     = [
    ...existing.filter(s => `${s.platform}::${s.mode}` !== key), // keep other sections
    newSection, // add/replace this section
  ];

  tickerStore = { pushedAt: Date.now(), sections: merged };
  saveTickerStore(tickerStore);
  syncToSupabase(tickerStore); // fire-and-forget — does not block response

  // Also push to the local display server (port 3002)
  try {
    publishToDisplay(normaliseResults(platform, mode, job.results, n));
  } catch (e: any) {
    origError('Display feed update failed:', e.message);
  }

  const total = merged.reduce((a, s) => a + s.items.length, 0);
  origLog(`Ticker updated: ${newSection.items.length} records pushed (${key}), ${total} total across ${merged.length} section(s)`);
  res.json({ ok: true, total: newSection.items.length, totalFeed: total, sections: merged.length });
});

/** POST /api/news/push — stores news rows inside the existing id=1 Supabase row (no INSERT needed) */
app.post('/api/news/push', (req: any, res: any): void => {
  const { rows, meta } = req.body as { rows: any[]; meta: any };
  if (!Array.isArray(rows)) { res.status(400).json({ error: 'rows must be array' }); return; }
  // Merge news into the existing tickerStore so syncToSupabase patches id=1 (always exists)
  const current = tickerStore ?? { pushedAt: Date.now(), sections: [] };
  (current as any).news = { rows, meta: { ...meta, pushedAt: Date.now() } };
  tickerStore = current as any;
  saveTickerStore(tickerStore);
  syncToSupabase(tickerStore); // reuses existing PATCH on id=1 — no RLS issue
  origLog(`News push: ${rows.length} rows merged into ticker store`);
  res.json({ ok: true, count: rows.length });
});

/** POST /api/news/clear */
app.post('/api/news/clear', (_req: any, res: any): void => {
  if (tickerStore) {
    delete (tickerStore as any).news;
    saveTickerStore(tickerStore);
    syncToSupabase(tickerStore);
  }
  res.json({ ok: true });
});

// ── Express 5 error handler ───────────────────────────────────────────────────
// In Express 5, errors thrown in async route handlers are automatically
// forwarded here — no need for try/catch in individual routes.

app.use((err: any, _req: any, res: any, _next: any) => {
  origError('Express error handler:', err.message);
  res.status(500).json({ ok: false, error: err.message });
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, (): void => {
  origLog(`\n  ╔══════════════════════════════════════════╗`);
  origLog(`  ║  SIGINT Admin  →  http://localhost:${PORT}   ║`);
  origLog(`  ╚══════════════════════════════════════════╝\n`);
  startDisplayServer(origLog);
});

// SPA fallback — MUST be after all /api/* routes
app.get('/', (_req: any, res: any): void => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
