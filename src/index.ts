/**
 * index.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original index.mjs.
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
 * index.mjs — Entry point
 * ─────────────────────────────────────────────────────────────────────────────
 * Launches the platform wizard, then delegates to the appropriate session.
 *
 *   npm start  /  node index.mjs
 */

import fs       from 'fs';
import inquirer from 'inquirer';

import { isPageAlive }                                       from './browser/page.js';
import { launchBrowserWithChoice, relaunchBrowserPrompt }    from './browser/launcher.js';
import { askPlatform }                                       from './cli/wizard.js';
import { runXSession }                                  from './x-session.js';
import { runInstagramSession }                               from './instagram-session.js';
import { runYoutubeSession }                                 from './youtube-session.js';
import { runRedditSession }                                  from './reddit-session.js';

// ── Banner ────────────────────────────────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   Instagram & YouTube Scraper  v4.0.0         ║');
  console.log('║   Posts · Stories · Search · Comments         ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function mainLoop() {
  printBanner();

  let { browser, page, userDataDir, keepOpen, isHeadless } =
    await launchBrowserWithChoice();

  let continueLoop = true;

  while (continueLoop) {
    // Browser health check
    if (!isPageAlive(page)) {
      const r = await relaunchBrowserPrompt();
      if (!r) break;
      try { await browser.close().catch(() => {}); } catch {}
      ({ browser, page, userDataDir } = r);
      isHeadless = false;
    }

    try {
      const platform = await askPlatform();
      console.log('');

      if (platform === 'instagram') {
        await runInstagramSession(browser, page, isHeadless);
      } else if (platform === 'youtube') {
        await runYoutubeSession(page);
      } else if (platform === 'reddit') {
        await runRedditSession(page, isHeadless);
      } else {
        await runXSession(page, isHeadless);
      }

    } catch (err) {
      console.error('\nFatal session error:', err.message);
      const r = await relaunchBrowserPrompt();
      if (!r) break;
      try { await browser.close().catch(() => {}); } catch {}
      ({ browser, page, userDataDir } = r);
      isHeadless = false;
    }

    const { runAgain } = await inquirer.prompt([{
      type:    'confirm',
      name:    'runAgain',
      message: 'Run another scrape session?',
      default: false,
    }]);
    continueLoop = runAgain;
  }

  console.log('\nAll sessions finished.');

  if (keepOpen) {
    console.log('Browser remains open — close it manually when done.');
  } else {
    try { await browser.close().catch(() => {}); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

mainLoop().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
