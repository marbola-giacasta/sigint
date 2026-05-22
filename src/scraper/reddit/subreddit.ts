/**
 * src/scraper/reddit/subreddit.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original subreddit.mjs.
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
 * src/scraper/reddit/subreddit.mjs
 * Scrapes posts (and basic metadata) from a specific subreddit.
 */

import { applyLimit }         from '../../utils/limit.js';
import { redditFetch, ensureRedditSession, normalisePost, normaliseSubreddit } from './api.js';

function parseSubredditName(input) {
  // Accept: r/name, /r/name, https://reddit.com/r/name, just "name"
  return input.replace(/^https?:\/\/(www\.)?reddit\.com/i, '')
              .replace(/^\/r\//i, '')
              .replace(/^r\//i, '')
              .replace(/\/$/, '')
              .split('/')[0]
              .trim();
}

export async function scrapeSubreddit(page, subredditInput, limitConfig, sort = 'hot', time = 'all') {
  await ensureRedditSession(page);
  const sub = parseSubredditName(subredditInput);
  console.log(`  → Subreddit: r/${sub} (sort: ${sort})`);

  // Subreddit metadata
  let meta = {};
  try {
    const aboutJson = await redditFetch(page, `https://www.reddit.com/r/${sub}/about.json`);
    meta = normaliseSubreddit(aboutJson?.data) ?? {};
  } catch { meta = { name: sub, title: '', url: `https://www.reddit.com/r/${sub}` }; }

  console.log(`  r/${sub}: "${(meta as any).title || sub}" — ${(meta as any).subscribers?.toLocaleString() || '?'} subscribers`);

  const target = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 25);
  const posts  = [];
  let   after  = '';
  let   page_n = 0;

  const timeParam = (sort === 'top' || sort === 'controversial') ? `&t=${time}` : '';

  while (posts.length < target) {
    const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=100${after ? `&after=${after}` : ''}${timeParam}`;
    const json = await redditFetch(page, url);
    const children = (json as any)?.data?.children ?? [];
    if (!children.length) break;

    for (const child of children) {
      const post = normalisePost(child.data, sub);
      if (post) posts.push(post);
    }

    after = (json as any)?.data?.after ?? '';
    process.stdout.write(`  Posts collected: ${posts.length}  (page ${++page_n})\r`);
    if (!after || posts.length >= target) break;
  }

  process.stdout.write('\n');
  const limited = applyLimit(posts, limitConfig);
  console.log(`  ✓ Collected ${limited.length} post(s) from r/${sub}`);
  return { meta, posts: limited };
}
