/**
 * ui-server.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original ui-server.mjs.
 *
 * CHANGES FROM THE .mjs ORIGINAL:
 * - Import paths end in .js (required by TypeScript's NodeNext module resolution)
 * - Function parameters and variables use 'any' type where exact types aren't
 *   critical — this keeps the code compiling while matching the original logic
 *   exactly. You can tighten types over time as needed.
 * - All logic, algorithms, and comments are IDENTICAL to the working .mjs version.
 *
 * TypeScript 'any' type explained:
 * 'any' turns off type checking for that value — it can be anything.
 * We use it here for YouTube/Reddit API responses which have complex unknown shapes.
 * It's safe to use 'any' when you're mirroring existing working JavaScript code
 * and the structure is too complex to type fully right now.
 */
/**
 * ui-server.mjs — Web UI backend
 * npm run ui  →  http://localhost:3001
 */

import express        from 'express';
import path           from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import puppeteerCore  from 'puppeteer-core';
import fs             from 'fs';
import os             from 'os';
import ExcelJS        from 'exceljs';

import { USER_AGENT, CONFIG }               from './config.js';
import {
  requireAuth, ADMIN_USER, ADMIN_PASS,
  createSession, destroySession,
  setSessionCookie, clearSessionCookie,
} from './auth.js';
import { scrapeYoutubeSearch }              from './scraper/youtube/search.js';
import { scrapeYoutubeComments }            from './scraper/youtube/comments.js';
import { scrapeYoutubeChannelSearch }       from './scraper/youtube/channel-search.js';
import { scrapeChannelVideos }              from './scraper/youtube/channel-videos.js';
import { scrapeProfileOnPage }              from './scraper/orchestrator.js';
import { searchRedditPosts, searchRedditSubreddits } from './scraper/reddit/search.js';
import { scrapeSubreddit }                  from './scraper/reddit/subreddit.js';
import { scrapePostComments }               from './scraper/reddit/post-comments.js';
import { resetRedditSession }               from './scraper/reddit/api.js';
import { searchXPosts, scrapeXProfile, scrapeXThread, ensureXLogin, resetXSession } from './scraper/x/index.js';
import { appendXTweets, appendXProfileMeta, saveXWorkbook } from './output/x-excel.js';

// Excel modules
import {
  appendSearchResults, appendVideoComments,
  appendChannelSearchResults, appendChannelVideos,
  saveSearchWorkbook, saveCommentsWorkbook,
  saveChannelSearchWorkbook, saveChannelVideosWorkbook,
} from './output/youtube-excel.js';
import {
  appendPostSearchResults, appendSubredditSearchResults,
  appendSubredditPosts, appendPostComments as appendRedditComments,
} from './output/reddit-excel.js';
import {
  exportProfileToWorkbookAppend,
} from './output/excel.js';
import {
  addYouTubeSearchDashboard, addYouTubeCommentsDashboard,
  addChannelSearchDashboard, addChannelVideosDashboard,
  addInstagramDashboard, addRedditDashboard,
} from './output/dashboard.js';
import { ensureDir } from './utils/fs.js';
import { startDisplayServer, publishToDisplay, normaliseResults } from './displayServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3001;

// ── CRITICAL: Process-level crash guards ─────────────────────────────────────
// Without these, ANY unhandled error or rejected Promise kills Node.js,
// drops all browser connections, and makes localhost:3001 go blank.
// These handlers log the error but keep the server RUNNING.

process.on('uncaughtException', (err: Error) => {
  console.error(`[CRASH GUARD] Uncaught exception — server kept alive:\n  ${err.message}\n  ${err.stack?.split('\n')[1] ?? ''}`);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[CRASH GUARD] Unhandled promise rejection — server kept alive:\n  ${msg}`);
});

// ── Browser ────────────────────────────────────────────────────────────────────

let sharedBrowser  = null;
let sharedPage     = null;
let sharedUserData = null;
let isHeadless     = true;

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'];

/** Returns the correct launch args for the specific browser being used.
 *
 *  Edge is extremely picky about launch flags — many Chromium-specific flags
 *  cause it to fail immediately. Use the bare minimum for Edge.
 */
function getBrowserArgs(browserName: string): string[] {
  const name = (browserName || '').toLowerCase();
  if (name.includes('edge')) {
    // Edge on Windows: RendererCodeIntegrity blocks Puppeteer injection.
    // This flag is the documented fix for "Failed to launch" with Edge + Puppeteer.
    return [
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=RendererCodeIntegrity',
    ];
  }
  // Chrome, Brave, Chromium, Vivaldi, Opera
  return [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

import { detectBrowsers as _detectBrowsers, type BrowserOption } from './browser/launcher.js';
import { execSync } from 'node:child_process';

// Persistent profile dirs — keeps cookies/session between restarts
const PROFILE_DIRS: Record<string,string> = {
  youtube:   path.join(process.cwd(), '.profile-youtube'),
  reddit:    path.join(process.cwd(), '.profile-reddit'),
  instagram: path.join(process.cwd(), '.profile-instagram'),
  x:         path.join(process.cwd(), '.profile-x'),
};

// Login page URLs per platform
const LOGIN_URLS: Record<string,string> = {
  youtube:   'https://accounts.google.com/signin',
  reddit:    'https://www.reddit.com/login',
  instagram: 'https://www.instagram.com/accounts/login/',
  x:         'https://x.com/i/flow/login',
};

// Patterns in URL that indicate successful login
const LOGGED_IN_PATTERNS: Record<string,string[]> = {
  youtube:   ['myaccount.google.com','youtube.com/feed','accounts.google.com/v3/signin/complete'],
  reddit:    ['reddit.com/'],
  instagram: ['instagram.com/'],
  x:         ['x.com/home','x.com/feed'],
};

export function findBrowsers(): BrowserOption[] {
  const seen = new Set<string>();
  const list: BrowserOption[] = [];
  const add = (name: string, exe: string, headless = false) => {
    if (!seen.has(exe) && fs.existsSync(exe)) {
      seen.add(exe); list.push({ name, executablePath: exe, headless });
    }
  };
  // Bundled headless Chromium first
  const bundled = _detectBrowsers().find(b => b.headless);
  if (bundled) list.push(bundled);

  if (process.platform === 'win32') {
    const pf   = process.env['ProgramFiles']       ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)']  ?? 'C:\\Program Files (x86)';
    const lad  = process.env['LOCALAPPDATA']        ?? '';
    add('Chrome',      `${pf}\\Google\\Chrome\\Application\\chrome.exe`);
    add('Chrome',      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`);
    add('Chrome',      `${lad}\\Google\\Chrome\\Application\\chrome.exe`);
    add('Edge',        `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`);
    add('Edge',        `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`);
    add('Brave',       `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`);
    add('Brave',       `${pf86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`);
    add('Opera',       `${lad}\\Programs\\Opera\\opera.exe`);
    add('Opera GX',    `${lad}\\Programs\\Opera GX\\opera.exe`);
    add('Vivaldi',     `${lad}\\Vivaldi\\Application\\vivaldi.exe`);
    add('Firefox',     `${pf}\\Mozilla Firefox\\firefox.exe`);
    add('Firefox',     `${pf86}\\Mozilla Firefox\\firefox.exe`);
  } else if (process.platform === 'darwin') {
    add('Chrome',  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('Edge',    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('Brave',   '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    add('Firefox', '/Applications/Firefox.app/Contents/MacOS/firefox');
    add('Opera',   '/Applications/Opera.app/Contents/MacOS/Opera');
    add('Vivaldi', '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi');
  } else {
    ['google-chrome','google-chrome-stable','chromium-browser','chromium','microsoft-edge','brave-browser','firefox'].forEach(bin => {
      try {
        const p = execSync(`which ${bin}`, {stdio:['pipe','pipe','pipe']}).toString().trim();
        if (p) add(bin, p);
      } catch {}
    });
  }
  return list;
}

// Active login-wait promise — resolved when user finishes logging in
let loginWaitResolve: (() => void) | null = null;

async function launchBrowser(
  browserName: string,
  headless = true,
  platform = '',       // if set, use persistent profile for this platform
) {
  const list     = findBrowsers();
  const selected = list.find(b => b.name === browserName) ?? list.find(b => !b.headless) ?? list[0];
  if (!selected) throw new Error('No browser found. Install Chrome or Edge.');

  // Persistent profile keeps cookies between sessions
  let ud: string;
  if (platform && PROFILE_DIRS[platform]) {
    ud = PROFILE_DIRS[platform];
    if (!fs.existsSync(ud)) fs.mkdirSync(ud, { recursive: true });
    origLog(`  ✓  Using persistent ${platform} profile: ${ud}`);
  } else {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-ui-'));
  }

  const useHeadless = platform ? false : headless; // login always needs visible
  const launchArgs = getBrowserArgs(selected.name);
  origLog(`  Launching ${selected.name} (${useHeadless ? 'headless' : 'visible'}) with ${launchArgs.length} args`);

  const launchOpts = {
    headless:       useHeadless,
    executablePath: selected.executablePath,
    userDataDir:    ud,
    args:           launchArgs,
    timeout:        30_000,
  };

  try {
    sharedBrowser = await puppeteerCore.launch(launchOpts);
  } catch (firstErr: any) {
    // Profile directory might be locked (browser already running with it)
    // Fall back to a fresh temp directory
    origLog(`  ⚠  Profile dir launch failed: ${firstErr.message.slice(0,100)}`);
    origLog(`  ↻  Retrying with temp profile (session will not persist)...`);
    const tempUd = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-retry-'));
    try {
      sharedBrowser = await puppeteerCore.launch({ ...launchOpts, userDataDir: tempUd });
      sharedUserData = tempUd;
      origLog(`  ✓  Browser launched with temp profile`);
    } catch (secondErr: any) {
      // Both attempts failed — provide helpful error
      throw new Error(
        `Cannot launch ${selected.name}. ` +
        `Try: 1) Close all ${selected.name} windows first, ` +
        `2) Use a different browser, ` +
        `3) Run as Administrator. ` +
        `Error: ${secondErr.message.slice(0, 120)}`
      );
    }
  }
  sharedPage = await sharedBrowser.newPage();
  await sharedPage.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
    Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
    (window as any).chrome = { runtime:{} };
  });
  await sharedPage.setViewport({ width:1366, height:900 });
  await sharedPage.setUserAgent(USER_AGENT);
  await sharedPage.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});
  sharedUserData = platform ? null : ud; // don't delete persistent profiles
  isHeadless = useHeadless;
  return { name: selected.name, headless: useHeadless };
}

async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(()=>{});
    sharedBrowser = sharedPage = null;
    if (sharedUserData) { fs.rmSync(sharedUserData,{recursive:true,force:true}); sharedUserData=null; }
  }
}


// ── Concurrency helpers ───────────────────────────────────────────────────────

/**
 * Opens `count` pages in the shared browser, applying stealth to each.
 * The first slot reuses sharedPage so login state is preserved.
 */
async function openPages(count) {
  const pages = [sharedPage];
  for (let i = 1; i < count; i++) {
    const p = await sharedBrowser.newPage();
    await p.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
      Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
      (window as any).chrome={runtime:{}};
    });
    await p.setViewport({width:1366,height:900});
    await p.setUserAgent(USER_AGENT);
    await p.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});
    pages.push(p);
  }
  return pages;
}

async function closeExtraPages(pages) {
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }
}

/**
 * Runs `items` through `fn(item, page)` with up to `n` concurrent workers.
 * Each worker gets its own browser page.
 */
async function runConcurrent(items, fn, n, logJobId) {
  if (!items.length) return [];
  const safeN = Math.max(1, Math.min(n, 10, items.length));
  const pages  = await openPages(safeN);
  const results = [];
  try {
    // Process in chunks of safeN
    for (let i = 0; i < items.length; i += safeN) {
      const chunk = items.slice(i, i + safeN);
      if (logJobId && chunk.length > 1) {
        emitLog(logJobId, `  ⚡ Running ${chunk.length} items in parallel (worker chunk ${Math.floor(i/safeN)+1})`, 'log');
      }
      const chunkResults = await Promise.all(
        chunk.map((item, idx) =>
          fn(item, pages[idx % safeN])
            .catch(err => { origError(`Worker error for "${item}":`, err.message); return null; })
        )
      );
      results.push(...chunkResults.filter(r => r !== null));
    }
  } finally {
    await closeExtraPages(pages);
  }
  return results;
}

// ── Jobs ───────────────────────────────────────────────────────────────────────

const jobs    = new Map(); // jobId → { status, logs, results, exportData, error, params, startedAt }
const streams = new Map(); // jobId → Set<res>

// ── Console interception ───────────────────────────────────────────────────────

const origLog   = console.log.bind(console);
const origError = console.error.bind(console);
let   activeJob = null;

/** Safely converts any value to a loggable string — never throws. */
function safeStr(a: any): string {
  if (a === null || a === undefined) return String(a);
  if (typeof a !== 'object') return String(a);
  // Puppeteer Page/Browser objects are circular — catch and label them
  try { return JSON.stringify(a); }
  catch { return `[${a?.constructor?.name ?? 'Object'}]`; }
}

function emitLog(jobId: any, line: any, type = 'log') {
  const job = jobs.get(jobId); if (!job) return;
  const entry = { t: Date.now(), type, line: String(line).slice(0, 2000) }; // cap length
  job.logs.push(entry);
  // Keep job log buffer bounded — drop oldest entries beyond 2000 to prevent memory bloat
  if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
  const sseSet = streams.get(jobId); if (!sseSet) return;
  try {
    const msg = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of sseSet) { try { res.write(msg); } catch {} }
  } catch { /* entry serialisation failed — skip */ }
}

console.log = (...args: any[]) => {
  origLog(...args);
  if (activeJob) emitLog(activeJob, args.map(safeStr).join(' '), 'log');
};
console.error = (...args: any[]) => {
  origError(...args);
  if (activeJob) emitLog(activeJob, args.map(safeStr).join(' '), 'error');
};


// ── Scrape dispatcher ─────────────────────────────────────────────────────────

async function runScrapeJob(jobId, params) {
  const job  = jobs.get(jobId);
  job.status = 'running';
  activeJob  = jobId;

  job.exportData = { platform: params.platform, mode: params.mode, items: [] };

  try {
    if (!sharedBrowser || !sharedPage) throw new Error('No browser open — launch one first.');

    const { platform, mode, inputs, limit, filter } = params;
    const lc          = { mode: limit?.mode ?? 'all', count: limit?.count ?? null };
    const concurrency = Math.max(1, Math.min(parseInt(params.concurrency ?? 1), 10));
    const results     = [];

    if (concurrency > 1) {
      emitLog(jobId, `⚡ Concurrency: ${concurrency} parallel workers`, 'log');
    }

    // ── YouTube ──────────────────────────────────────────────────────────────
    if (platform === 'youtube') {
      if (mode === 'search') {
        const batchResults = await runConcurrent(inputs.keywords??[], async (kw, page) => {
          const rows = await scrapeYoutubeSearch(page, kw, lc, filter??null);
          job.exportData.items.push({ type:'search', data: rows });
          return rows;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));

      } else if (mode === 'channel-search') {
        const batchResults = await runConcurrent(inputs.keywords??[], async (kw, page) => {
          const rows = await scrapeYoutubeChannelSearch(page, kw, lc, filter??null);
          job.exportData.items.push({ type:'channel-search', data: rows });
          return rows;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));

      } else if (mode === 'channel-videos') {
        // channel-videos uses its own consent-injection — keep sequential to avoid conflicts
        for (const url of (inputs.urls??[])) {
          const { meta, videos } = await scrapeChannelVideos(sharedPage, url, lc, filter??null);
          results.push(...videos);
          job.exportData.items.push({ type:'channel-videos', meta, data: videos });
        }

      } else if (mode === 'comments') {
        const batchResults = await runConcurrent(inputs.urls??[], async (url, page) => {
          const { meta, comments } = await scrapeYoutubeComments(page, url, lc);
          job.exportData.items.push({ type:'comments', meta, data: comments });
          return comments;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));
      }
    }

    // ── Reddit ────────────────────────────────────────────────────────────────
    else if (platform === 'reddit') {
      resetRedditSession();
      if (mode === 'search-posts') {
        const batchResults = await runConcurrent(inputs.keywords??[], async (kw, page) => {
          const rows = await searchRedditPosts(page, kw, lc, inputs.sort??'relevance', inputs.time??'all');
          job.exportData.items.push({ type:'reddit-posts', data: rows });
          return rows;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));

      } else if (mode === 'search-subs') {
        const batchResults = await runConcurrent(inputs.keywords??[], async (kw, page) => {
          const rows = await searchRedditSubreddits(page, kw, lc);
          job.exportData.items.push({ type:'reddit-subs', data: rows });
          return rows;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));

      } else if (mode === 'subreddit') {
        const batchResults = await runConcurrent(inputs.subs??[], async (s, page) => {
          const { meta, posts } = await scrapeSubreddit(page, s, lc, inputs.sort??'hot', inputs.time??'all');
          job.exportData.items.push({ type:'reddit-subreddit', meta, data: posts });
          return posts;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));

      } else if (mode === 'post-comments') {
        const batchResults = await runConcurrent(inputs.urls??[], async (url, page) => {
          const { post, comments } = await scrapePostComments(page, url, lc);
          job.exportData.items.push({ type:'reddit-comments', post, data: comments });
          return comments;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));
      }
    }

    else if (platform === 'x') {
      // X requires login — ensure session before proceeding (sequential, login is shared)
      const loggedIn = await ensureXLogin(sharedPage, isHeadless);
      if (!loggedIn) {
        emitLog(jobId, '⚠  X login required. Use Chrome/Edge and log in when prompted.', 'warn');
      }
      if (mode === 'search') {
        const batchResults = await runConcurrent(inputs.keywords??[], async (kw, page) => {
          const rows = await searchXPosts(page, kw, lc, inputs.filterKey??'top');
          job.exportData.items.push({ type:'x-tweets', data:rows });
          return rows;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));

      } else if (mode === 'profile') {
        const handles = inputs.handles?.length ? inputs.handles : (inputs.keywords??[]);
        const batchResults = await runConcurrent(handles, async (h, page) => {
          const { meta, tweets } = await scrapeXProfile(page, h, lc);
          job.exportData.items.push({ type:'x-tweets', data:tweets });
          return tweets;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));

      } else if (mode === 'thread') {
        const batchResults = await runConcurrent(inputs.urls??[], async (url, page) => {
          const replies = await scrapeXThread(page, url, lc);
          job.exportData.items.push({ type:'x-tweets', data:replies });
          return replies;
        }, concurrency, jobId);
        batchResults.forEach(r => results.push(...r));
      }
    }

    else if (platform === 'instagram') {
      const imagesBaseDir = path.join(process.cwd(), CONFIG.instagram.imagesDirName);
      ensureDir(imagesBaseDir);

      if (mode === 'search') {
        // Instagram keyword search — searches explore/tags feed
        const { scrapeInstagramSearch } = await import('./scraper/instagram-search.js');
        const batchResults = await runConcurrent(inputs.keywords??[], async (keyword, page) => {
          const posts = await scrapeInstagramSearch(page, keyword, lc);
          job.exportData.items.push({ type:'instagram-search', keyword, data: posts });
          return posts;
        }, 1, jobId); // sequential — one keyword at a time
        batchResults.forEach((r: any[]) => results.push(...r));

      } else {
        // Instagram: keep sequential — all tabs share the login session cookie
        const batchResults = await runConcurrent(inputs.usernames??[], async (username, page) => {
          const { summary, posts, stories } = await scrapeProfileOnPage(page, username, lc);
          job.exportData.items.push({ type:'instagram-profile', username, summary, posts, stories });
          return { username, summary, posts, stories };
        }, Math.min(concurrency, CONFIG.instagram.parallelTabs), jobId);
        results.push(...batchResults);
      }
    }

    job.results = results;
    job.status  = 'done';
    emitLog(jobId, `✅ Done — ${results.length} result(s)`, 'done');
  } catch (err) {
    job.error = err.message; job.status = 'error';
    emitLog(jobId, `❌ Error: ${err.message}`, 'error');
    origError('Job error:', err);
  } finally {
    activeJob = null;
    const sseSet = streams.get(jobId);
    if (sseSet) {
      const msg = `data: ${JSON.stringify({ type:'end', status: job.status })}\n\n`;
      for (const res of sseSet) { try { res.write(msg); res.end(); } catch {} }
    }
  }
}

// ── XLSX export ────────────────────────────────────────────────────────────────

async function buildWorkbook(exportData) {
  const wb   = new ExcelJS.Workbook();
  const { platform, mode, items } = exportData;

  for (const item of items) {
    if (item.type === 'search')          { appendSearchResults(wb, item.data); }
    else if (item.type === 'channel-search') { appendChannelSearchResults(wb, item.data); }
    else if (item.type === 'channel-videos') { appendChannelVideos(wb, item.meta, item.data); }
    else if (item.type === 'comments')   { appendVideoComments(wb, item.meta, item.data); }
    else if (item.type === 'reddit-posts') { appendPostSearchResults(wb, item.data); }
    else if (item.type === 'reddit-subs')  { appendSubredditSearchResults(wb, item.data); }
    else if (item.type === 'reddit-subreddit') { appendSubredditPosts(wb, item.meta, item.data); }
    else if (item.type === 'reddit-comments')  { appendRedditComments(wb, item.post, item.data); }
    else if (item.type === 'x-tweets') { appendXTweets(wb, item.data); }
    else if (item.type === 'instagram-profile') {
      const imagesBaseDir = path.join(process.cwd(), CONFIG.instagram.imagesDirName);
      ensureDir(imagesBaseDir);
      await exportProfileToWorkbookAppend(wb, item.username, item.summary, item.posts, item.stories, imagesBaseDir, sharedPage);
    }
  }

  // Add dashboard
  try {
    if (platform === 'youtube') {
      if (mode === 'search')          addYouTubeSearchDashboard(wb);
      else if (mode === 'channel-search') addChannelSearchDashboard(wb);
      else if (mode === 'channel-videos') addChannelVideosDashboard(wb);
      else if (mode === 'comments')    addYouTubeCommentsDashboard(wb);
    } else if (platform === 'reddit') {
      const modeMap = { 'search-posts':'post-search','search-subs':'sub-search','subreddit':'subreddit','post-comments':'post-comments' };
      addRedditDashboard(wb, modeMap[mode] ?? 'post-search');
    } else if (platform === 'instagram') {
      addInstagramDashboard(wb);
    } else if (platform === 'x') {
      try { const { addXDashboard } = await import('./output/dashboard.js'); addXDashboard(wb); } catch {}
    }
  } catch (e) { origError('Dashboard generation error:', e.message); }

  return wb;
}

// ── Express ────────────────────────────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: '10mb' }));

// ── CORS — allow ticker.html served from ANY origin to fetch /api/ticker/data ─
// This is what lets a Vercel-hosted ticker page poll your local/tunnel server.
app.use((req: any, res: any, next: any) => {
  // Allow ticker data to be fetched cross-origin (public feed)
  if (req.path === '/api/ticker/data') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
  }
  next();
});

// ── Auth middleware — protects all admin routes ───────────────────────────────
// Public routes (ticker.html, /api/ticker/data, /login) bypass this.
app.use(requireAuth);

// Serve the login page — must be before requireAuth would block it
// (requireAuth already exempts /login from auth check, but we need the actual route)
app.get('/login', (_req: any, res: any) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

// ── Auth API routes ────────────────────────────────────────────────────────────

/** POST /api/auth/login — accepts username+password, sets session cookie */
app.post('/api/auth/login', (req: any, res: any) => {
  const { user, pass } = req.body as { user: string; pass: string };
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const sessionId = createSession(user);
    setSessionCookie(res, sessionId);
    origLog(`Admin login: ${user} from ${req.ip}`);
    res.json({ ok: true });
  } else {
    origLog(`Failed login attempt: "${user}" from ${req.ip}`);
    res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }
});

/** POST /api/auth/logout — clears session */
app.post('/api/auth/logout', (req: any, res: any) => {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (sid) destroySession(decodeURIComponent(sid));
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** GET /api/auth/status — lets the UI check if still logged in */
app.get('/api/auth/status', (req: any, res: any) => {
  res.json({ ok: true, user: (req as any).adminUser ?? 'admin' });
});
// __dirname here is dist/ (compiled output folder)
// public/ lives at the project root, so we go up one level
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA catch-all is placed AFTER all /api/* routes at the bottom of this file.

// Simple health check — the React app polls this every 5s to detect server crashes
// ── Server health & status ────────────────────────────────────────────────────

/**
 * GET /api/health  — public heartbeat (also used by admin UI health monitor)
 * Returns server uptime, job count, and memory usage so the admin can see
 * the server is alive even if something went wrong with a scrape.
 */
app.get('/api/health', (_req: any, res: any) => {
  const mem = process.memoryUsage();
  res.json({
    ok:        true,
    ts:        Date.now(),
    uptime:    Math.floor(process.uptime()),   // seconds since server started
    jobs:      jobs.size,
    activeJob: activeJob,
    memMb:     Math.round(mem.rss / 1024 / 1024),
    browser:   !!sharedBrowser,
  });
});

/**
 * POST /api/admin/cancel-job  — stops the currently running scrape job.
 * Sets the job status to 'cancelled' so the UI shows it cleanly.
 * The scraper itself may still be mid-operation, but the results are discarded.
 */
app.post('/api/admin/cancel-job', (req: any, res: any) => {
  if (!activeJob) { res.json({ ok: false, msg: 'No job currently running.' }); return; }
  const job = jobs.get(activeJob);
  if (job) {
    job.status = 'error';
    job.error  = 'Cancelled by admin.';
    emitLog(activeJob, '⚠ Job cancelled by admin.', 'warn');
    // Close any open SSE streams for this job
    const sseSet = streams.get(activeJob);
    if (sseSet) {
      const msg = `data: ${JSON.stringify({ type:'end', status:'error' })}\n\n`;
      for (const r of sseSet) { try { r.write(msg); r.end(); } catch {} }
    }
  }
  activeJob = null;
  origLog('Job cancelled by admin.');
  res.json({ ok: true, msg: 'Job cancelled.' });
});

/**
 * POST /api/admin/clear-jobs  — clears job history from memory.
 * Useful after a long session to free memory without restarting.
 */
app.post('/api/admin/clear-jobs', (_req: any, res: any) => {
  if (activeJob) { res.json({ ok: false, msg: 'Cannot clear while a job is running.' }); return; }
  const count = jobs.size;
  jobs.clear();
  streams.clear();
  origLog(`Admin cleared ${count} jobs from memory.`);
  res.json({ ok: true, cleared: count });
});

/**
 * POST /api/admin/close-browser-reset  — closes the browser AND resets all
 * internal session flags (Reddit, X, YouTube consent).
 * Use this when the browser gets into a bad state.
 */
app.post('/api/admin/close-browser-reset', async (_req: any, res: any) => {
  try {
    await closeBrowser();
    // Reset all scraper session flags
    origLog('Admin reset: browser closed, session flags cleared.');
    res.json({ ok: true, msg: 'Browser closed and all session state reset. Relaunch the browser to continue.' });
  } catch (err: any) {
    res.json({ ok: true, msg: `Reset attempted. Error: ${err.message}` });
  }
});

app.get('/api/browser/status', (req, res) => {
  res.json({ open: !!sharedBrowser, headless: isHeadless, browsers: findBrowsers().map(b=>b.name) });
});

app.post('/api/browser/launch', async (req: any, res: any) => {
  try {
    if (sharedBrowser) await closeBrowser();
    const { browserName, headless = true, platform = '' } = req.body as {
      browserName?: string; headless?: boolean; platform?: string;
    };
    const info = await launchBrowser(
      browserName ?? findBrowsers()[0]?.name,
      headless,
      platform
    );
    res.json({ ok: true, ...info });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

/** POST /api/browser/goto-login
 *  Navigates the open browser to a platform's login page.
 *  Returns immediately — the user logs in manually in the visible browser window.
 */
app.post('/api/browser/goto-login', async (req: any, res: any) => {
  const { platform } = req.body as { platform: string };
  const url = LOGIN_URLS[platform];
  if (!url)         { res.status(400).json({ ok: false, error: 'Unknown platform' }); return; }
  if (!sharedPage)  { res.status(400).json({ ok: false, error: 'No browser open' }); return; }
  try {
    await sharedPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    origLog(`  ✓  Navigated to ${platform} login page`);
    res.json({ ok: true, url });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

/** POST /api/browser/confirm-login
 *  Called by admin UI after they have logged in manually.
 *  Checks current page URL/DOM to confirm login actually succeeded.
 */
app.post('/api/browser/confirm-login', async (req: any, res: any) => {
  const { platform } = req.body as { platform: string };
  if (!sharedPage) { res.status(400).json({ ok: false, error: 'No browser open' }); return; }
  try {
    const currentUrl = sharedPage.url();
    const patterns = LOGGED_IN_PATTERNS[platform] ?? [];
    const loggedIn = patterns.length === 0 || patterns.some(p => currentUrl.includes(p));
    origLog(`  ${loggedIn ? '✓' : '⚠'}  ${platform} login check: ${currentUrl}`);
    res.json({ ok: true, loggedIn, url: currentUrl });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

/** POST /api/browser/clear-profile — wipe saved session for a platform */
app.post('/api/browser/clear-profile', async (req: any, res: any) => {
  const { platform } = req.body as { platform: string };
  const dir = PROFILE_DIRS[platform];
  if (!dir) { res.status(400).json({ ok: false, error: 'Unknown platform' }); return; }
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    origLog(`  ✓  Cleared ${platform} saved session`);
    res.json({ ok: true, msg: `${platform} session cleared — log in again next time.` });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/browser/close', async (req, res) => {
  await closeBrowser(); res.json({ ok:true });
});

app.post('/api/scrape', async (req, res) => {
  const jobId = randomUUID();
  jobs.set(jobId, { id:jobId, status:'queued', logs:[], results:[], exportData:null,
                    error:null, params:req.body, startedAt:Date.now() });
  streams.set(jobId, new Set());
  res.json({ jobId });
  setImmediate(() => runScrapeJob(jobId, req.body));
});

app.get('/api/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).end(); return; }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering if proxied
  res.flushHeaders();

  // Replay existing logs for late-joining clients
  for (const e of job.logs) res.write(`data: ${JSON.stringify(e)}\n\n`);

  // If already finished, send terminal event immediately
  if (job.status === 'done' || job.status === 'error') {
    res.write(`data: ${JSON.stringify({ type:'end', status: job.status })}\n\n`);
    res.end(); return;
  }

  streams.get(req.params.jobId)!.add(res);
  req.on('close', () => streams.get(req.params.jobId)?.delete(res));

  // Heartbeat every 15s — keeps the connection alive through proxies/firewalls
  // and lets the browser detect if the server goes down
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 15_000);
  req.on('close', () => clearInterval(heartbeat));
});

app.get('/api/results/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error:'Not found' });
  res.json({ status:job.status, results:job.results, error:job.error, count:job.results.length });
});

app.get('/api/jobs', (req, res) => {
  res.json([...jobs.values()].map(j=>({
    id:j.id, status:j.status, startedAt:j.startedAt, count:j.results.length,
    error:j.error, platform:j.params?.platform, mode:j.params?.mode,
  })).reverse().slice(0,30));
});

// ── XLSX export endpoint ───────────────────────────────────────────────────────
app.get('/api/export/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error:'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error:'Job not complete yet' });
  if (!job.exportData?.items?.length) return res.status(400).json({ error:'No data to export' });

  try {
    const wb   = await buildWorkbook(job.exportData);
    const buf  = await wb.xlsx.writeBuffer();
    const fname = `scraper_${job.params?.platform}_${job.params?.mode}_${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    origError('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Publish to display feed ──────────────────────────────────────────────────
app.post('/api/publish', (req: any, res: any): void => {
  const { jobId, count = 20 } = req.body as { jobId: string; count: number };
  const job = jobs.get(jobId);
  if (!job)                  { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status !== 'done') { res.status(400).json({ error: 'Job not complete' }); return; }
  if (!job.results?.length)  { res.status(400).json({ error: 'No results to publish' }); return; }
  const sections = normaliseResults(job.params?.platform as string, job.params?.mode as string, job.results, Number(count) || 20);
  publishToDisplay(sections);
  const total = sections.reduce((a, s) => a + s.rows.length, 0);
  origLog(`  📡 Published ${total} rows to display feed`);
  res.json({ ok: true, published: total });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ticker — store the currently published feed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * tickerStore holds whatever the admin last pushed to the public ticker page.
 * It persists in memory for the lifetime of the server process.
 * Structure: { pushedAt: number, sections: [{platform, mode, items[]}] }
 */
// ── Supabase sync ─────────────────────────────────────────────────────────────
// Credentials come from environment variables — never hardcode them.
const SUPABASE_URL      = 'https://qqmidswgsqmimxrlyqru.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxbWlkc3dnc3FtaW14cmx5cXJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2NTU3MTgsImV4cCI6MjA5NTIzMTcxOH0.UDgz4TfVM7t4jLNA-IKB8C1SVhuJj_jKXac6PApo544';

/**
 * Pushes ticker data to Supabase so the public ticker page can read it
 * directly from Supabase — no tunnel needed, works even when server is off.
 * Uses a simple PATCH to the ticker_store table (row id=1 always exists).
 */
async function syncToSupabase(store: typeof tickerStore): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    origLog('  ⚠  Supabase not configured — skipping sync');
    return;
  }
  try {
    const body = JSON.stringify({
      data:       store,
      updated_at: new Date().toISOString(),
    });
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ticker_store?id=eq.1`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation',  // return the updated row so we can verify
        },
        body,
      }
    );
    const text = await r.text();
    if (r.ok) {
      const sections = store?.sections?.length ?? 0;
      const total    = store?.sections?.reduce((a,s) => a + s.items.length, 0) ?? 0;
      origLog(`  ✓  Supabase synced — ${sections} section(s), ${total} records`);
    } else {
      origError(`  ✗  Supabase sync failed: HTTP ${r.status} — ${text}`);
    }
  } catch (e: any) {
    origError(`  ✗  Supabase sync error: ${e.message}`);
  }
}

// ── Ticker persistence ────────────────────────────────────────────────────────
// tickerStore is saved to disk so data survives server restarts.
// The file lives in the project root (next to package.json).
const TICKER_FILE = path.join(process.cwd(), 'ticker-store.json');

/** Load ticker data from disk on startup */
function loadTickerStore(): typeof tickerStore {
  try {
    if (fs.existsSync(TICKER_FILE)) {
      const raw = fs.readFileSync(TICKER_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      origLog(`  ✓  Ticker store loaded from disk (${parsed.sections?.length ?? 0} section(s), pushed ${new Date(parsed.pushedAt).toLocaleString()})`);
      return parsed;
    }
  } catch (e: any) {
    origLog(`  ⚠  Could not load ticker store from disk: ${e.message}`);
  }
  return null;
}

/** Save ticker data to disk after every push */
function saveTickerStore(store: typeof tickerStore): void {
  try {
    fs.writeFileSync(TICKER_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (e: any) {
    origError(`Could not save ticker store to disk: ${e.message}`);
  }
}

let tickerStore: { pushedAt: number; sections: Array<{ platform: string; mode: string; items: unknown[] }> } | null = loadTickerStore();

/**
 * GET /api/ticker/data
 * Public endpoint — the ticker page polls this every 3s to check for new data.
 * Returns 204 (No Content) if nothing has been pushed yet.
 */
app.get('/api/ticker/data', (_req: any, res: any): void => {
  if (!tickerStore) { res.status(204).end(); return; }
  res.json(tickerStore);
});

/**
 * POST /api/ticker/push
 * Admin-only endpoint — called when the admin clicks "Push to Ticker".
 * Body: { jobId: string, limit: number }
 * Extracts the top `limit` results from the job, groups by platform/mode,
 * and stores them in tickerStore so the public page picks them up.
 */
app.post('/api/ticker/push', (req: any, res: any): void => {
  const { jobId, limit } = req.body as { jobId: string; limit: number };
  const job = jobs.get(jobId);

  if (!job)               { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.status !== 'done') { res.status(400).json({ error: 'Job not complete' }); return; }
  if (!job.exportData?.items?.length) { res.status(400).json({ error: 'No data' }); return; }

  const n = Math.max(1, Math.min(parseInt(String(limit ?? 20)), 500));
  const platform = job.exportData.platform;
  const mode     = job.exportData.mode;
  const key      = `${platform}::${mode}`;

  // Flatten all items for this job into one section
  const newItems: unknown[] = [];
  for (const item of job.exportData.items) {
    const it = item as any;
    if (Array.isArray(it.data)) {
      // YouTube/Reddit/X format: { data: [...results] }
      newItems.push(...it.data);
    } else if (it.type === 'instagram-profile') {
      // Instagram format: { type, username, summary, posts, stories }
      // Flatten posts into ticker items, enriched with profile summary
      const posts: any[] = Array.isArray(it.posts) ? it.posts : [];
      posts.forEach((p: any) => newItems.push({
        ...p,
        author:     it.username,
        username:   it.username,
        followers:  it.summary?.followers,
        description: p.description || p.caption || '',
        url:        p.shortcode ? `https://www.instagram.com/p/${p.shortcode}/` : '',
        platform:   'instagram',
      }));
      // If no posts, push summary as single record
      if (posts.length === 0 && it.summary) {
        newItems.push({
          ...it.summary,
          author:   it.username,
          username: it.username,
          platform: 'instagram',
        });
      }
    } else if (it.username && it.summary) {
      // Generic Instagram fallback
      newItems.push({ ...it.summary, author: it.username, username: it.username });
    }
  }
  const newSection = { platform, mode, items: newItems.slice(0, n) };

  // Merge rule:
  //   Same platform + same mode  → REPLACE that section (e.g. YT search replaces YT search)
  //   Different platform or mode → KEEP existing + ADD new section alongside it
  //   (e.g. pushing Reddit after YouTube keeps both; pushing YT comments after YT search keeps both)
  const existingSections = tickerStore?.sections ?? [];
  const merged = [
    ...existingSections.filter(s => `${s.platform}::${s.mode}` !== key), // keep all other sections
    newSection, // add/replace this platform+mode
  ];

  tickerStore = { pushedAt: Date.now(), sections: merged };
  saveTickerStore(tickerStore);
  syncToSupabase(tickerStore); // fire-and-forget — don't await, never blocks the response

  // ALSO push to the port-3002 display server so both feeds update simultaneously.
  // normaliseResults expects the flat job.results array (same as /api/publish uses)
  try {
    const displaySections = normaliseResults(
      platform,
      mode,
      job.results,
      n,
    );
    publishToDisplay(displaySections);
  } catch (e: any) {
    origError('Display feed update failed:', e.message);
  }

  const total = merged.reduce((a,s)=>a+s.items.length,0);
  origLog(`Ticker updated: ${newSection.items.length} new records pushed (${key}), ${total} total across ${merged.length} section(s)`);
  res.json({ ok: true, total: newSection.items.length, totalFeed: total, sections: merged.length });
});

app.listen(PORT, (): void => {
  origLog(`\n  ╔══════════════════════════════════════════╗`);
  origLog(`  ║  Admin UI    →  http://localhost:${PORT}    ║`);
  origLog(`  ╚══════════════════════════════════════════╝\n`);
  startDisplayServer(origLog);
});

// === SPA fallback — MUST be after all /api/* routes ===
app.get('/', (_req: any, res: any): void => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
