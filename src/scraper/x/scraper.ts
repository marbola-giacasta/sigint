/**
 * src/scraper/x/scraper.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original scraper.mjs.
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
 * src/scraper/x/scraper.mjs
 * X (Twitter) scraper — uses DOM scraping on the rendered web app.
 * No API key required. Works with or without login.
 *
 * Modes:
 *  searchTweets  — search tweets by keyword (with date/sort filters)
 *  userTweets    — all tweets from a @handle
 *  tweetReplies  — replies under a specific tweet URL
 */
import { sleep }                             from '../../utils/sleep.js';
import { applyLimit }                        from '../../utils/limit.js';
import { dismissPopups, handleConsentGate }  from '../../browser/page.js';

const BASE = 'https://x.com';

// ── Login helper ──────────────────────────────────────────────────────────────

let sessionReady = false;
export function resetXSession() { sessionReady = false; }

export async function ensureXSession(page, wantLogin = false, timeoutMs = 180_000) {
  if (sessionReady) return;

  await page.goto(`${BASE}/home`, { waitUntil:'domcontentloaded', timeout:60_000 }).catch(()=>{});
  await sleep(2_000);
  await handleConsentGate(page);
  await dismissPopups(page);

  const isLoggedIn = await page.evaluate(()=>
    !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]')
  ).catch(()=>false);

  if (isLoggedIn) { console.log('  ✓  X session: already logged in.'); sessionReady=true; return; }

  if (!wantLogin) {
    console.log('  ℹ️  X session: using guest (not logged in). Some content may be limited.');
    sessionReady=true; return;
  }

  // Navigate to login page and wait for user
  await page.goto(`${BASE}/i/flow/login`, { waitUntil:'domcontentloaded', timeout:30_000 }).catch(()=>{});
  console.log('\n  ⏳  Please log in to X in the browser window.');
  console.log(`     Waiting up to ${timeoutMs/60_000} minutes...\n`);

  const start = Date.now();
  while (Date.now()-start < timeoutMs) {
    await sleep(2_000);
    const ok = await page.evaluate(()=>
      !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]')
    ).catch(()=>false);
    if (ok) { console.log('  ✓  X login confirmed.\n'); sessionReady=true; return; }
  }
  console.log('  ⚠  X login timeout — continuing as guest.');
  sessionReady=true;
}

// ── Tweet normaliser ──────────────────────────────────────────────────────────

async function extractTweetsFromPage(page, keyword='', maxExisting=0) {
  return page.evaluate((kw)=>{
    const tweets = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach((el, i) => {
      // Author
      const authorEl = el.querySelector('[data-testid="User-Name"]');
      const displayName = authorEl?.querySelector('span')?.textContent?.trim() ?? '';
      const handleEl   = authorEl?.querySelectorAll('span')?.[2]?.textContent?.trim() ?? '';
      const handle = handleEl.startsWith('@') ? handleEl : '@'+handleEl;

      // Text
      const textEl  = el.querySelector('[data-testid="tweetText"]');
      const text    = textEl?.textContent?.trim() ?? '';

      // Time + link
      const timeEl  = el.querySelector('time');
      const timestamp = timeEl?.getAttribute('datetime') ?? '';
      const tweetLink = (el.querySelector('a[href*="/status/"]') as any)?.href ?? '';
      const tweetId   = tweetLink.match(/\/status\/(\d+)/)?.[1] ?? '';

      // Stats
      const stats = {};
      ['reply','retweet','like','bookmark','views'].forEach(k=>{
        const el2 = document.querySelector(`[data-testid="${k}"]`);
        stats[k] = el2?.textContent?.replace(/[^0-9KMB.]/gi,'').trim() ?? '0';
      });
      // Better: get stats from each article
      const replyCount   = el.querySelector('[data-testid="reply"]   span')?.textContent?.trim() ?? '0';
      const retweetCount = el.querySelector('[data-testid="retweet"] span')?.textContent?.trim() ?? '0';
      const likeCount    = el.querySelector('[data-testid="like"]    span')?.textContent?.trim() ?? '0';
      const viewsEl      = [...el.querySelectorAll('span')].find(s=>s.textContent?.includes(' views'));
      const viewCount    = viewsEl?.textContent?.replace(/[^0-9KMB.]/gi,'').trim() ?? '0';

      // Media
      const hasMedia = !!el.querySelector('img[src*="pbs.twimg.com/media"], video');
      const imgUrl   = (el.querySelector('img[src*="pbs.twimg.com/media"]') as any)?.src ?? '';

      if (text || tweetId) tweets.push({
        tweetId, keyword: kw, displayName, handle, text,
        timestamp, tweetUrl: tweetLink,
        replies: replyCount, retweets: retweetCount, likes: likeCount, views: viewCount,
        hasMedia: hasMedia ? 'yes':'no', imageUrl: imgUrl,
      });
    });
    return tweets;
  }, keyword);
}

// ── Scroll collector ──────────────────────────────────────────────────────────

async function scrollAndCollect(page, keyword, limitConfig, maxScrolls=40) {
  const target = limitConfig.mode==='all' ? 9_999 : (limitConfig.count ?? 50);
  const seen   = new Map(); // tweetId or text → tweet
  let noNewCount = 0;

  for (let s = 0; s < maxScrolls && seen.size < target && noNewCount < 6; s++) {
    const tweets = await extractTweetsFromPage(page, keyword).catch(()=>[]);
    for (const t of tweets) {
      const key = t.tweetId || t.text.slice(0,80);
      if (!seen.has(key)) seen.set(key, { ...t, index: seen.size });
    }
    process.stdout.write(`  Tweets collected: ${seen.size}  (scroll ${s+1})\r`);
    const before = seen.size;
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight)).catch(()=>{});
    await sleep(2_200);
    if (seen.size === before) noNewCount++; else noNewCount=0;
  }
  process.stdout.write('\n');
  return applyLimit([...seen.values()], limitConfig);
}

// ── Search tweets ─────────────────────────────────────────────────────────────

// X search filter params
const X_FILTERS = {
  null:         '',          // Latest (default)
  top:          '&f=top',    // Top tweets
  live:         '&f=live',   // Live
  people:       '&f=user',   // People
};

export async function searchXTweets(page, keyword, limitConfig, filter=null, wantLogin=false) {
  await ensureXSession(page, wantLogin);
  console.log(`  → X search: "${keyword}"`);
  const q       = encodeURIComponent(keyword);
  const fParam  = X_FILTERS[filter] ?? '';
  const url     = `${BASE}/search?q=${q}&src=typed_query${fParam}`;

  await page.goto(url, { waitUntil:'domcontentloaded', timeout:60_000 });
  await sleep(3_000);
  await dismissPopups(page);

  const tweets = await scrollAndCollect(page, keyword, limitConfig);
  console.log(`  Found ${tweets.length} tweet(s) for "${keyword}"`);
  return tweets;
}

// ── User tweets ───────────────────────────────────────────────────────────────

export async function scrapeUserTweets(page, handle, limitConfig, wantLogin=false) {
  await ensureXSession(page, wantLogin);
  const h = handle.replace(/^@/,'');
  console.log(`  → X user tweets: @${h}`);
  await page.goto(`${BASE}/${h}`, { waitUntil:'domcontentloaded', timeout:60_000 });
  await sleep(3_000);
  await dismissPopups(page);

  // Extract user meta
  const meta = await page.evaluate(()=>{
    const name = document.querySelector('[data-testid="UserName"] span')?.textContent?.trim() ?? '';
    const bio  = document.querySelector('[data-testid="UserDescription"]')?.textContent?.trim() ?? '';
    const followers = document.querySelector('a[href*="followers"] span')?.textContent?.trim() ?? '';
    const following = document.querySelector('a[href*="following"] span')?.textContent?.trim() ?? '';
    return { name, bio, followers, following };
  }).catch(()=>({}));

  const tweets = await scrollAndCollect(page, `@${h}`, limitConfig);
  console.log(`  Found ${tweets.length} tweet(s) for @${h}`);
  return { meta: { handle:h, ...meta }, tweets };
}

// ── Tweet replies ─────────────────────────────────────────────────────────────

export async function scrapeTweetReplies(page, tweetUrl, limitConfig, wantLogin=false) {
  await ensureXSession(page, wantLogin);
  console.log(`  → X tweet replies: ${tweetUrl}`);
  const normUrl = tweetUrl.replace('twitter.com','x.com');
  await page.goto(normUrl, { waitUntil:'domcontentloaded', timeout:60_000 });
  await sleep(3_000);
  await dismissPopups(page);

  // First tweet is the original
  const origTweet = await extractTweetsFromPage(page, '').then(ts=>ts[0]).catch(()=>null);
  const replies   = await scrollAndCollect(page, tweetUrl, limitConfig);
  // First item is the OP — mark rest as replies
  const replyList = replies.slice(1).map((t,i)=>({...t, index:i, isReply:'yes', originalTweetUrl:tweetUrl}));

  console.log(`  Found ${replyList.length} replies.`);
  return { originalTweet: origTweet, replies: replyList };
}
