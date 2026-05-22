/**
 * src/browser/page.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Low-level page utilities shared by all scrapers.
 *
 * WHAT EACH FUNCTION DOES:
 *
 * isPageAlive()      → checks if a browser tab is still open and usable
 * retryOperation()   → runs an async function, retries on failure
 * safeGoto()         → navigates to a URL with automatic retry
 * dismissPopups()    → clicks common "Dismiss/Close/Accept" overlay buttons
 * handleConsentGate()→ auto-accepts YouTube's GDPR consent redirect
 *
 * PUPPETEER BASICS:
 * Page = one browser tab. page.goto(url) = navigate. page.evaluate(fn) = run
 * JavaScript inside the tab (has access to document, window, DOM).
 */
import type { Page } from 'puppeteer-core';
import { CONFIG }    from '../config.js';
import { sleep }     from '../utils/sleep.js';

// ─────────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the page is still open and the browser is still connected.
 * Called before each operation to avoid "Target closed" crashes.
 *
 * TYPESCRIPT: Page | null | undefined covers "page might not exist yet"
 */
export function isPageAlive(page: Page | null | undefined): boolean {
  if (!page) return false;
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) return false;
    if (!page.mainFrame()) return false;
    // page.browser() returns the Browser — check it's still connected
    const b = (page as any).browser?.();
    if (b && typeof b.isConnected === 'function' && !b.isConnected()) return false;
    return true;
  } catch {
    return false; // any error = page is dead
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs fn(), and if it fails, waits delayMs then tries again, up to maxRetries times.
 * Used for network operations that might fail due to transient connection issues.
 *
 * TYPESCRIPT GENERIC <T>: the return type matches whatever fn() returns.
 * If fn() returns Promise<string>, retryOperation also returns Promise<string>.
 *
 * @param fn         - Async function to try
 * @param maxRetries - Total attempts allowed (default from config)
 * @param delayMs    - Wait between attempts (default from config)
 */
export async function retryOperation<T>(
  fn:          () => Promise<T>,
  maxRetries = CONFIG.gotoRetryCount,
  delayMs    = CONFIG.gotoRetryDelayMs,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(); // try the operation
    } catch (err: any) {
      if (attempt === maxRetries) throw err; // last attempt: give up
      console.log(`  Retry ${attempt}/${maxRetries}: ${err.message}`);
      await sleep(delayMs); // wait before retrying
    }
  }
  throw new Error('retryOperation: unreachable'); // TypeScript requires a final throw
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigates to url with automatic retry on failure.
 * waitUntil: 'domcontentloaded' = wait for HTML only (not all images/scripts).
 * networkidle2 = wait until <2 network connections for 500ms — more complete.
 */
export async function safeGoto(page: Page, url: string): Promise<void> {
  await retryOperation(async () => {
    if (!isPageAlive(page)) throw new Error('Page closed');
    await page.goto(url, {
      waitUntil: ['domcontentloaded', 'networkidle2'],
      timeout:   CONFIG.navTimeout,
    });
    await sleep(2_000); // let post-load JS run
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup dismissal
// ─────────────────────────────────────────────────────────────────────────────

/** Text labels that typically appear on dismiss/accept buttons */
const DISMISS = [
  'Not now', 'Not Now', 'Dismiss', 'Close',
  'Accept All', 'Allow all cookies', 'Allow essential and optional cookies',
];

/**
 * Clicks the first visible popup dismiss button.
 * page.evaluate() runs code INSIDE the browser tab — has access to document/DOM.
 * We pass DISMISS as a parameter because page.evaluate() runs in a separate context
 * and cannot directly access variables from our Node.js scope.
 */
export async function dismissPopups(page: Page): Promise<void> {
  await page.evaluate((labels: string[]) => {
    // querySelectorAll finds all matching DOM elements
    for (const btn of document.querySelectorAll('button,[role="button"]')) {
      const text = (btn.textContent ?? '').trim();
      if (labels.some(l => text.includes(l))) {
        (btn as any).click();
        return; // click only the first matching button
      }
    }
  }, DISMISS).catch(() => {}); // ignore errors (page might be in transition)
  await sleep(500);
}

// ─────────────────────────────────────────────────────────────────────────────
// GDPR consent gate (YouTube & Google)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects and bypasses YouTube's GDPR consent redirect.
 *
 * HOW IT WORKS:
 * In EU/Switzerland, YouTube redirects to consent.youtube.com before any content.
 * When you click "Accept all", YouTube sets a SOCS cookie on .youtube.com.
 * We try to click that button automatically. If clicking fails, we wait 30s
 * for the user to click manually in the browser window.
 *
 * @returns true if consent was resolved, false if it timed out
 */
export async function handleConsentGate(page: Page): Promise<boolean> {
  const url = page.url();
  // Only act if we're on the consent page
  if (!url.includes('consent.youtube.com') && !url.includes('consent.google.com')) return false;

  console.log('  ℹ️  YouTube consent gate detected — accepting automatically...');

  // Try to click the accept button
  const accepted = await page.evaluate((): boolean => {
    const labels = [
      'Accept all', 'Accept All',
      'Alle akzeptieren', 'Tout accepter', // German, French
      'Accetta tutto', 'Aceitar tudo',     // Italian, Portuguese
      'Aceptar todo', 'I agree', 'Agree', 'Confirm', 'Continue',
    ];
    const allButtons = [
      ...document.querySelectorAll('button, [role="button"], input[type="submit"]'),
    ];
    for (const btn of allButtons) {
      const text = ((btn as HTMLInputElement).textContent ?? (btn as HTMLInputElement).value ?? '').trim();
      if (labels.some(l => text.toLowerCase().includes(l.toLowerCase()))) {
        (btn as any).click();
        return true;
      }
    }
    // Fallback: click the first primary form button
    const primary = document.querySelector(
      'form button.VfPpkd-LgbsSe, form button[class*="primary"], form input[type="submit"]',
    ) as HTMLElement | null;
    if (primary) { primary.click(); return true; }
    return false;
  }).catch((): boolean => false);

  if (accepted) {
    // Wait for navigation away from the consent page
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    await sleep(1_500);
    console.log('  ✓  Consent accepted — continuing.');
    return true;
  }

  // Auto-click failed — give user 30 seconds
  console.log('  ⚠  Could not auto-accept consent.');
  console.log('     Please click "Accept all" in the browser window (30 s timeout).');
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    await sleep(1_000);
    const cur = page.url();
    if (!cur.includes('consent.youtube.com') && !cur.includes('consent.google.com')) {
      console.log('  ✓  Consent resolved — continuing.');
      return true;
    }
  }
  console.log('  ⚠  Consent timeout. Proceeding anyway.');
  return false;
}
