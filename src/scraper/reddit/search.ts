/**
 * src/scraper/reddit/search.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original search.mjs.
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
 * src/scraper/reddit/search.mjs
 * Search Reddit for posts or subreddits matching a keyword.
 * Uses Reddit's public /search.json endpoint — no auth required.
 */

import { sleep }              from '../../utils/sleep.js';
import { applyLimit }         from '../../utils/limit.js';
import { redditFetch, ensureRedditSession, normalisePost, normaliseSubreddit } from './api.js';

const SORT_PARAM = { relevance:'relevance', hot:'hot', top:'top', new:'new', comments:'comments' };
const TIME_PARAM = { all:'all', year:'year', month:'month', week:'week', day:'day', hour:'hour' };

// ── Post search ───────────────────────────────────────────────────────────────

export async function searchRedditPosts(page, keyword, limitConfig, sort = 'relevance', time = 'all') {
  await ensureRedditSession(page);
  console.log(`  → Reddit post search: "${keyword}" (sort: ${sort}, time: ${time})`);

  const target  = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 25);
  const posts   = [];
  let   after   = '';
  let   page_n  = 0;

  while (posts.length < target) {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=${SORT_PARAM[sort]||'relevance'}&t=${TIME_PARAM[time]||'all'}&limit=100${after ? `&after=${after}` : ''}`;
    const json = await redditFetch(page, url);
    const children = (json as any)?.data?.children ?? [];
    if (!children.length) break;

    for (const child of children) {
      const post = normalisePost(child.data);
      if (post) posts.push(post);
    }

    after = (json as any)?.data?.after ?? '';
    process.stdout.write(`  Posts found: ${posts.length}  (page ${++page_n})\r`);
    if (!after || posts.length >= target) break;
  }

  process.stdout.write('\n');
  const limited = applyLimit(posts, limitConfig);
  console.log(`  Found ${limited.length} post(s) for "${keyword}"`);
  return limited;
}

// ── Subreddit search ──────────────────────────────────────────────────────────

export async function searchRedditSubreddits(page, keyword, limitConfig) {
  await ensureRedditSession(page);
  console.log(`  → Reddit subreddit search: "${keyword}"`);

  const target  = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 25);
  const subs    = [];
  let   after   = '';
  let   page_n  = 0;

  while (subs.length < target) {
    const url = `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(keyword)}&limit=100${after ? `&after=${after}` : ''}`;
    const json = await redditFetch(page, url);
    const children = (json as any)?.data?.children ?? [];
    if (!children.length) break;

    for (const child of children) {
      const sub = normaliseSubreddit(child.data);
      if (sub) subs.push(sub);
    }

    after = (json as any)?.data?.after ?? '';
    process.stdout.write(`  Subreddits found: ${subs.length}  (page ${++page_n})\r`);
    if (!after || subs.length >= target) break;
  }

  process.stdout.write('\n');
  const limited = applyLimit(subs, limitConfig);
  console.log(`  Found ${limited.length} subreddit(s) for "${keyword}"`);
  return limited;
}
