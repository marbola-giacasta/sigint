/**
 * src/scraper/x/index.ts
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
 * src/scraper/x/index.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * X (Twitter) scraper via GraphQL API interception.
 *
 * IMPORTANT: X requires login for virtually all content since 2024.
 * Without a valid session cookie, SearchTimeline and UserTweets return
 * empty results. Login is enforced before any scrape begins.
 *
 * Strategy
 * ─────────
 * 1. Navigate to x.com/login and wait for user to complete login.
 * 2. Navigate to the target URL (search / profile / tweet).
 * 3. Intercept GraphQL responses: SearchTimeline, UserTweets, TweetDetail.
 * 4. Deep-walk each response to extract tweet objects.
 * 5. Scroll to paginate.
 */

import { sleep }      from '../../utils/sleep.js';
import { applyLimit } from '../../utils/limit.js';
import { dismissPopups } from '../../browser/page.js';

const BASE = 'https://x.com';

// ── Session state ─────────────────────────────────────────────────────────────

let xSessionActive = false;

export function resetXSession() { xSessionActive = false; }

// ── Login ─────────────────────────────────────────────────────────────────────

export async function ensureXLogin(page, isHeadless = false) {
  if (xSessionActive) return true;

  // Check if already logged in (home feed visible)
  const loggedIn = await page.evaluate(() => {
    return !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
        || !!document.querySelector('[data-testid="primaryColumn"]')
        || (window.location.hostname === 'x.com' && !window.location.pathname.startsWith('/i/flow'));
  }).catch(() => false);

  if (loggedIn) { xSessionActive = true; return true; }

  if (isHeadless) {
    console.log('  ⚠  X requires login — headless mode cannot show the login form.');
    console.log('     Use a visible browser (Chrome / Edge) for X scraping.');
    return false;
  }

  console.log('\n  ══════════════════════════════════════════');
  console.log('  ✦  X LOGIN REQUIRED');
  console.log('  X (Twitter) requires you to be logged in.');
  console.log('  Opening the login page now...');
  console.log('  Please log in and the scraper will continue automatically.');
  console.log('  ══════════════════════════════════════════\n');

  try {
    await page.goto(`${BASE}/i/flow/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(2_000);
    await dismissPopups(page);

    // Wait up to 3 minutes for login to complete
    await page.waitForFunction(
      () => !window.location.pathname.startsWith('/i/flow/login')
         && !window.location.pathname.startsWith('/i/flow/'),
      { timeout: 180_000, polling: 1_500 },
    );

    await sleep(3_000);
    console.log('  ✓  X login detected — continuing!\n');
    xSessionActive = true;
    return true;
  } catch {
    console.log('  ⚠  Login timeout. Results may be empty without a valid session.\n');
    return false;
  }
}

// ── Tweet normaliser ──────────────────────────────────────────────────────────

function normaliseTweet(obj, contextQuery = '', contextType = '') {
  // Unwrap nested result structures
  const result = obj?.tweet ?? obj;
  const legacy = result?.legacy ?? result?.tweet?.legacy ?? {};
  const user   = result?.core?.user_results?.result?.legacy
              ?? result?.user_results?.result?.legacy
              ?? {};

  const tweetId = legacy.id_str ?? result?.rest_id ?? '';
  if (!tweetId || !legacy.full_text) return null;

  return {
    tweetId,
    text:           legacy.full_text.replace(/^RT @\w+: /, '').slice(0, 2000),
    author:         user.screen_name     ?? '',
    authorName:     user.name            ?? '',
    authorVerified: (user.verified || user.is_blue_verified) ? 'Yes' : 'No',
    authorFollowers: user.followers_count ?? 0,
    likes:          legacy.favorite_count ?? 0,
    retweets:       legacy.retweet_count  ?? 0,
    replies:        legacy.reply_count    ?? 0,
    quotes:         legacy.quote_count    ?? 0,
    views:          result?.views?.count  ?? '',
    timestamp:      legacy.created_at
                      ? new Date(legacy.created_at).toISOString()
                      : '',
    language:       legacy.lang           ?? '',
    isRetweet:      legacy.retweeted_status_result ? 'Yes' : 'No',
    isReply:        legacy.in_reply_to_status_id_str ? 'Yes' : 'No',
    tweetUrl:       user.screen_name
                      ? `${BASE}/${user.screen_name}/status/${tweetId}`
                      : '',
    contextQuery,
    contextType,
  };
}

// ── Deep-walk response for tweet objects ─────────────────────────────────────

function extractTweetsFromResponse(json, contextQuery, contextType) {
  const out = [];
  if (!json) return out;

  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 20) return;
    // Tweet node: has __typename Tweet and legacy.full_text
    if (obj.__typename === 'Tweet' && obj.legacy?.full_text) {
      const t = normaliseTweet(obj, contextQuery, contextType);
      if (t) { out.push(t); return; } // don't recurse into tweet internals
    }
    // TweetWithVisibilityResults wrapper
    if (obj.__typename === 'TweetWithVisibilityResults' && obj.tweet) {
      const t = normaliseTweet(obj.tweet, contextQuery, contextType);
      if (t) { out.push(t); return; }
    }
    if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth+1)); return; }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v, depth+1);
    }
  }

  walk(json);
  return out;
}

// ── Response collector ────────────────────────────────────────────────────────

function createXCollector(page) {
  const batches = [];
  const PATTERNS = [
    'SearchTimeline', 'UserTweets', 'TweetDetail',
    'HomeTimeline', 'HomeLatestTimeline',
  ];
  const handler = async res => {
    const url = res.url();
    if (!PATTERNS.some(p => url.includes(p))) return;
    try { batches.push(await res.json()); } catch {}
  };
  page.on('response', handler);
  return { batches, stop: () => page.off('response', handler) };
}

// ── X search filters ──────────────────────────────────────────────────────────

export const X_SEARCH_FILTERS = {
  top:    { label: 'Top (default)',   param: '' },
  latest: { label: 'Latest (newest)', param: '&f=live' },
  media:  { label: 'Photos & Videos', param: '&f=image' },
  people: { label: 'People',          param: '&f=user' },
};

// ── Shared scroll-and-collect loop ────────────────────────────────────────────

async function scrollAndCollect(page, collector, contextQuery, contextType, target, maxScrolls = 40) {
  const seenIds = new Set();
  const results = [];

  function drain() {
    for (const batch of collector.batches) {
      for (const t of extractTweetsFromResponse(batch, contextQuery, contextType)) {
        if (t.tweetId && !seenIds.has(t.tweetId)) {
          seenIds.add(t.tweetId);
          results.push(t);
        }
      }
    }
    collector.batches.length = 0;
  }

  await sleep(3_000); // let initial response arrive
  drain();

  let noNew   = 0;
  let scrolls = 0;

  while (results.length < target && noNew < 6 && scrolls < maxScrolls) {
    const before = results.length;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await sleep(2_200);
    drain();
    process.stdout.write(`  Tweets: ${results.length} / ${target}  (scroll ${scrolls + 1})\r`);
    noNew = results.length === before ? noNew + 1 : 0;
    scrolls++;
  }
  process.stdout.write('\n');
  drain(); // final drain

  return results;
}

// ── Search ────────────────────────────────────────────────────────────────────

export async function searchXPosts(page, keyword, limitConfig, filterKey = 'top') {
  const _xt0 = Date.now();
  console.log(`  ┌─ X Search ────────────────────────────────────────`);
  console.log(`  │  Query  : "${keyword}"  [filter: ${filterKey}]`);
  console.log(`  │  Target : ${limitConfig.mode==='all'?'ALL':'Top '+limitConfig.count}`);
  console.log(`  └───────────────────────────────────────────────────`);

  const filterParam = X_SEARCH_FILTERS[filterKey]?.param ?? '';
  const url = `${BASE}/search?q=${encodeURIComponent(keyword)}&src=typed_query${filterParam}`;

  const collector = createXCollector(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissPopups(page);

  const target  = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 50);
  const results = await scrollAndCollect(page, collector, keyword, 'search', target);
  collector.stop();

  const limited = applyLimit(results, limitConfig);
  limited.slice(0,8).forEach((t,i) => {
    const auth = String((t as any).author     ||'').slice(0,16).padEnd(16);
    const txt  = String((t as any).text       ||'').replace(/\n/g,' ').slice(0,48).padEnd(48);
    const lk   = String((t as any).likes      ||0).padStart(6,' ');
    const rt   = String((t as any).retweets   ||0).padStart(5,' ');
    const dt   = String((t as any).timestamp  ||'').slice(0,10);
    console.log(`  ${String(i+1).padStart(3,' ')}  @${auth}  ${lk}♥  ${rt}↻  ${dt}  ${txt}`);
  });
  const _xel = ((Date.now()-_xt0)/1000).toFixed(1);
  console.log(`  ✓ X search "${keyword}" — ${limited.length} tweets in ${_xel}s`);

  if (limited.length === 0) {
    console.log('  ⚠  0 results. X search requires login — ensure you are logged in.');
  }

  return limited;
}

// ── Profile ───────────────────────────────────────────────────────────────────

export async function scrapeXProfile(page, usernameOrUrl, limitConfig) {
  const clean = usernameOrUrl.trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(x|twitter)\.com\//i, '')
    .split('/')[0];
  const _xp0 = Date.now();
  console.log(`  ┌─ X Profile ────────────────────────────────────────`);
  console.log(`  │  Handle : @${clean}`);
  console.log(`  │  Target : ${limitConfig.mode==='all'?'ALL':'Top '+limitConfig.count}`);
  console.log(`  └───────────────────────────────────────────────────`);

  const collector = createXCollector(page);
  await page.goto(`${BASE}/${clean}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissPopups(page);

  const meta = await page.evaluate(() => ({
    title:       document.title ?? '',
    description: (document.querySelector('meta[name="description"]') as any)?.content ?? '',
  })).catch(() => ({}));

  const target  = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 50);
  const tweets  = await scrollAndCollect(page, collector, clean, 'profile', target, 50);
  collector.stop();

  const limited = applyLimit(tweets, limitConfig);
  limited.slice(0,5).forEach((t,i) => {
    const txt = String((t as any).text||'').replace(/\n/g,' ').slice(0,60);
    const lk  = String((t as any).likes||0).padStart(6,' ');
    const dt  = String((t as any).timestamp||'').slice(0,10);
    console.log(`  ${String(i+1).padStart(3,' ')}  ${lk}♥  ${dt}  ${txt}`);
  });
  const _xpe = ((Date.now()-_xp0)/1000).toFixed(1);
  console.log(`  ✓ @${clean} — ${limited.length} tweets in ${_xpe}s`);
  return { meta: { username: clean, ...meta }, tweets: limited };
}

// ── Thread ────────────────────────────────────────────────────────────────────

export async function scrapeXThread(page, tweetUrl, limitConfig) {
  const normUrl = tweetUrl.trim().replace('twitter.com', 'x.com');
  const _xth0 = Date.now();
  console.log(`  ┌─ X Thread ────────────────────────────────────────`);
  console.log(`  │  URL: ${normUrl.slice(0,60)}`);
  console.log(`  └───────────────────────────────────────────────────`);

  const collector = createXCollector(page);
  await page.goto(normUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissPopups(page);

  const target  = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 100);
  const tweets  = await scrollAndCollect(page, collector, normUrl, 'thread', target, 60);
  collector.stop();

  const limited = applyLimit(tweets, limitConfig);
  limited.slice(0,5).forEach((t,i) => {
    const auth = String((t as any).author||'').slice(0,16).padEnd(16);
    const txt  = String((t as any).text||'').replace(/\n/g,' ').slice(0,50);
    const lk   = String((t as any).likes||0).padStart(6,' ');
    console.log(`  ${String(i+1).padStart(3,' ')}  @${auth}  ${lk}♥  ${txt}`);
  });
  const _xthe = ((Date.now()-_xth0)/1000).toFixed(1);
  console.log(`  ✓ Thread — ${limited.length} tweets in ${_xthe}s`);
  return limited;
}
