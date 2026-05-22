/**
 * src/cli/login.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original login.mjs.
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
import inquirer from 'inquirer';
import { CONFIG } from '../config.js';
import { sleep }  from '../utils/sleep.js';

export async function performLoginIfRequested(page, isHeadless) {
  if (isHeadless) {
    console.log('\n⚠  Headless mode — login skipped. Only public profiles will be accessible.\n');
    return false;
  }

  const { wantsLogin } = await inquirer.prompt([{
    type:    'confirm',
    name:    'wantsLogin',
    message: 'Log in to Instagram before scraping?\n  (Required for private profiles & stories)',
    default: true,
  }]);

  if (!wantsLogin) { console.log('\nSkipping login.\n'); return false; }

  await page.goto(`${CONFIG.instagram.baseUrl}/accounts/login/`, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeout });
  console.log(`\nComplete login in the browser window (${CONFIG.instagram.loginTimeoutMs / 60_000} min timeout).\n`);

  try {
    await page.waitForFunction(
      () => !window.location.pathname.startsWith('/accounts/login'),
      { timeout: CONFIG.instagram.loginTimeoutMs, polling: 1_500 },
    );
    await sleep(3_000);
    console.log('Login detected — continuing!\n');
    return true;
  } catch {
    console.log('Login timeout. Continuing with current session.\n');
    return false;
  }
}
