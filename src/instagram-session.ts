/**
 * instagram-session.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original instagram-session.mjs.
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
 * instagram-session.mjs
 * One complete Instagram scrape session: login → prompts → scrape → export.
 */

import ExcelJS from 'exceljs';

import { CONFIG }                  from './config.js';
import { sleep }                   from './utils/sleep.js';
import { ensureDir }               from './utils/fs.js';
import { isPageAlive }             from './browser/page.js';
import { configPage }              from './browser/launcher.js';
import { performLoginIfRequested } from './cli/login.js';
import {
  askPostsLimit, askProfileMode,
  getProfilesSingle, getProfilesFromExcel,
}                                  from './cli/prompts.js';
import { scrapeProfileOnPage }     from './scraper/orchestrator.js';
import {
  exportSingleProfileWorkbook,
  exportProfileToWorkbookAppend,
}                                  from './output/excel.js';
import { addInstagramDashboard }   from './output/dashboard.js';
import path from 'path';

async function openBatchPages(browser, mainPage, count, isFirstBatch) {
  const pages = [];
  for (let i = 0; i < count; i++) {
    if (i === 0 && isFirstBatch) { pages.push(mainPage); }
    else { const p = await browser.newPage(); await configPage(p); pages.push(p); }
  }
  return pages;
}

async function closeBatchPages(pages, mainPage) {
  for (const p of pages) { if (p === mainPage) continue; try { await p.close().catch(() => {}); } catch {} }
}

export async function runInstagramSession(browser, mainPage, isHeadless) {
  const imagesBaseDir = path.join(process.cwd(), CONFIG.instagram.imagesDirName);
  ensureDir(imagesBaseDir);

  await performLoginIfRequested(mainPage, isHeadless);

  const limitConfig = await askPostsLimit();
  const profileMode = await askProfileMode();
  const profiles    = profileMode === 'single'
    ? await getProfilesSingle()
    : await getProfilesFromExcel();

  if (profileMode === 'single') {
    const { summary, posts, stories } = await scrapeProfileOnPage(mainPage, profiles[0], limitConfig);
    await exportSingleProfileWorkbook(profiles[0], summary, posts, stories, imagesBaseDir, mainPage);
    return;
  }

  // Batch mode
  const multiWorkbook = new ExcelJS.Workbook();
  const chunkSize     = CONFIG.instagram.parallelTabs;

  for (let i = 0; i < profiles.length; i += chunkSize) {
    const chunk        = profiles.slice(i, i + chunkSize);
    const isFirstBatch = i === 0;
    console.log(`\n── Batch ${Math.floor(i / chunkSize) + 1} (${i + 1}–${i + chunk.length} of ${profiles.length}) ──`);

    const pages = await openBatchPages(browser, mainPage, chunk.length, isFirstBatch);

    const results = await Promise.all(
      chunk.map((profile, idx) =>
        scrapeProfileOnPage(pages[idx], profile, limitConfig)
          .then(r => ({ profile, ...r }))
          .catch(err => { console.error(`  ✖ "${profile}": ${err.message}`); return { profile, summary: {}, posts: [], stories: [] }; }),
      ),
    );

    for (let idx = 0; idx < results.length; idx++) {
      const { profile, summary, posts, stories } = results[idx];
      try { await exportProfileToWorkbookAppend(multiWorkbook, profile, summary, posts, stories, imagesBaseDir, pages[idx]); }
      catch (err) { console.error(`  Export failed for "${profile}": ${err.message}`); }
    }

    await closeBatchPages(pages, mainPage);

    if (i + chunkSize < profiles.length) {
      console.log(`  Pausing ${CONFIG.instagram.batchPauseMs / 1_000}s...`);
      await sleep(CONFIG.instagram.batchPauseMs);
    }
  }

  const fileName = `ig_scraper_multiple_${Date.now()}.xlsx`;
  addInstagramDashboard(multiWorkbook);
  await multiWorkbook.xlsx.writeFile(fileName);
  console.log(`\n  ✔ Saved → ${fileName}`);
}
