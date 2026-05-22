/**
 * src/scraper/reddit/api.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original api.mjs.
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
 * src/scraper/reddit/api.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around Reddit's public JSON API.
 * No auth required for public content.
 * Rate limit: 1 req / sec recommended. We enforce it via sleep(1100).
 *
 * All calls are made via page.evaluate(fetch) so Reddit's CDN sees a normal
 * browser User-Agent with cookies — much less likely to get 429'd than
 * a raw Node.js HTTP client.
 */

import { sleep } from '../../utils/sleep.js';

const BASE = 'https://www.reddit.com';
const UA   = 'Mozilla/5.0 (compatible; ResearchBot/1.0)';

// ── Core fetch via page.evaluate ──────────────────────────────────────────────

/**
 * Fetches a Reddit JSON endpoint from inside the Puppeteer page context.
 * This gives us Reddit's cookies and a real browser UA automatically.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} url  — full URL including .json suffix and query params
 * @returns {Promise<any>}
 */
export async function redditFetch(page, url) {
  await sleep(1_100); // respect rate limit

  return page.evaluate(async (url) => {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }, url).catch(err => { throw new Error(`Reddit fetch failed: ${err.message}`); });
}

// ── Ensure Reddit is open in the browser ─────────────────────────────────────

let redditInitialised = false;

/**
 * Navigate to Reddit once to establish cookies / session, then reuse.
 * Subsequent calls are no-ops.
 */
export async function ensureRedditSession(page) {
  if (redditInitialised) return;
  const url = page.url();
  if (!url.includes('reddit.com')) {
    await page.goto('https://www.reddit.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(2_000);
    // Dismiss cookie banner if present
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        if (/accept|agree|got it/i.test(b.textContent)) { b.click(); return; }
      }
    }).catch(() => {});
    await sleep(500);
  }
  redditInitialised = true;
}

export function resetRedditSession() { redditInitialised = false; }

// ── Normalisers ───────────────────────────────────────────────────────────────

export function normalisePost(data, subreddit = '') {
  if (!data) return null;
  const created = data.created_utc ? new Date(data.created_utc * 1000).toISOString() : '';
  return {
    postId:        data.id            ?? '',
    title:         data.title         ?? '',
    author:        data.author        ?? '',
    subreddit:     data.subreddit     ?? subreddit,
    postUrl:       data.url           ?? '',
    permalink:     data.permalink ? `https://www.reddit.com${data.permalink}` : '',
    score:         data.score         ?? 0,
    upvoteRatio:   data.upvote_ratio  ?? '',
    numComments:   data.num_comments  ?? 0,
    flair:         data.link_flair_text ?? '',
    isVideo:       data.is_video      ?? false,
    isSelf:        data.is_self       ?? false,
    selfText:      (data.selftext     ?? '').slice(0, 1000),
    thumbnail:     data.thumbnail     ?? '',
    createdUtc:    created,
    domain:        data.domain        ?? '',
  };
}

export function normaliseComment(data, postTitle = '', postUrl = '', depth = 0) {
  if (!data || data.kind === 'more') return null;
  const d = data.data ?? data;
  const created = d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '';
  return {
    commentId:   d.id            ?? '',
    postTitle,
    postUrl,
    author:      d.author        ?? '',
    subreddit:   d.subreddit     ?? '',
    body:        (d.body         ?? '').replace(/\n+/g, ' ').slice(0, 2000),
    score:       d.score         ?? 0,
    depth,
    isTopLevel:  depth === 0 ? 'yes' : 'no',
    createdUtc:  created,
    permalink:   d.permalink ? `https://www.reddit.com${d.permalink}` : '',
  };
}

export function normaliseSubreddit(data) {
  if (!data) return null;
  return {
    name:           data.display_name         ?? '',
    title:          data.title                ?? '',
    url:            data.url ? `https://www.reddit.com${data.url}` : '',
    subscribers:    data.subscribers          ?? 0,
    activeUsers:    data.accounts_active      ?? 0,
    description:    (data.public_description  ?? '').slice(0, 500),
    type:           data.subreddit_type       ?? '',
    nsfw:           data.over18               ?? false,
    created:        data.created_utc ? new Date(data.created_utc*1000).toISOString() : '',
    icon:           data.icon_img             ?? data.community_icon ?? '',
  };
}

/**
 * Optional Reddit login — opens reddit.com/login and waits for user.
 * Useful for accessing private subreddits, higher rate limits, etc.
 */
export async function performRedditLoginIfRequested(page, isHeadless) {
  if (isHeadless) {
    console.log('  ⚠  Headless mode — Reddit login skipped.');
    return false;
  }
  const { default: inquirer } = await import('inquirer');
  const { want } = await inquirer.prompt([{
    type:'confirm', name:'want',
    message:'Log in to Reddit? (Optional — useful for private subs & higher rate limits)',
    default: false,
  }]);
  if (!want) return false;

  await page.goto('https://www.reddit.com/login/', { waitUntil:'domcontentloaded', timeout:60_000 });
  console.log('\nPlease log in to Reddit in the browser (2 min timeout).\n');

  try {
    await page.waitForFunction(
      () => !window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/account'),
      { timeout: 120_000, polling: 1_500 },
    );
    const { sleep } = await import('../../utils/sleep.js');
    await sleep(2_000);
    console.log('Reddit login detected!\n');
    resetRedditSession();
    return true;
  } catch {
    console.log('Reddit login timeout. Continuing anonymously.\n');
    return false;
  }
}
