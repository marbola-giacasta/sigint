/**
 * TypeScript conversion — all logic identical to the working .mjs original.
 * Import paths use .js extension (TypeScript NodeNext requirement).
 * 'any' types used for API responses with complex/unknown shapes.
 */
import { CONFIG }                              from '../config.js';
import { sleep }                               from '../utils/sleep.js';
import { isPageAlive }                         from '../browser/page.js';
import { scrapeProfileSummary }                from './profile.js';
import { scrapePostsFeed, scrapePostDetails }  from './posts.js';
import { scrapeStories }                       from './stories.js';

export async function scrapeProfileOnPage(page, username, limitConfig) {
  let summary = {};
  let posts   = [];
  let stories = [];

  try {
    if (!isPageAlive(page)) throw new Error('Page is closed or disconnected');

    summary = await scrapeProfileSummary(page, username);
    console.log(`  ┌─ Instagram Profile ─────────────────────────────`);
  console.log(
      `  Summary — followers: ${(summary as any).followers || '?'}, ` +
      `posts: ${(summary as any).posts || '?'}, following: ${(summary as any).following || '?'}`,
    );

    console.log(`  [${username}] Collecting posts...`);
    posts = await scrapePostsFeed(page, username, (summary as any).userId, limitConfig);
    posts.slice(0,5).forEach((p: any,i: number) => {
      const desc = String(p.description||p.caption||'').replace(/\n/g,' ').slice(0,50).padEnd(50);
      const lk   = String(p.likes||'?').padStart(7,' ');
      const cm   = String(p.commentsCount||'?').padStart(5,' ');
      const dt   = String(p.timestamp||'').slice(0,10);
      console.log(`  ${String(i+1).padStart(3,' ')}  ${lk}♥  ${cm}💬  ${dt}  ${desc}`);
    });
    console.log(`  [${username}] Found ${posts.length} post(s). Fetching per-post details...`);

    for (let i = 0; i < posts.length; i++) {
      process.stdout.write(`    Post ${i + 1} / ${posts.length}...\r`);
      posts[i] = await scrapePostDetails(page, posts[i]);
      await sleep(CONFIG.instagram.postDetailDelay + Math.random() * 800);
    }
    if (posts.length > 0) process.stdout.write(`  [${username}] Post details done.          \n`);

    // Pass userId so stories.mjs can do tighter URL matching
    stories = await scrapeStories(page, username, (summary as any).userId, limitConfig);

  } catch (err) {
    console.error(`  ✖  Error processing "${username}": ${err.message}`);
  }

  return { summary, posts, stories };
}
