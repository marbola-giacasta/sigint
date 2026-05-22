/**
 * reddit-session.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original reddit-session.mjs.
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
import ExcelJS from 'exceljs';
import { CONFIG } from './config.js';
import { sleep }  from './utils/sleep.js';
import {
  askRedditMode, askRedditSortTime, askSubredditSort,
  askKeywords, askSubredditInput, askPostUrls, askLimit,
} from './cli/reddit-prompts.js';
import { searchRedditPosts, searchRedditSubreddits } from './scraper/reddit/search.js';
import { scrapeSubreddit }   from './scraper/reddit/subreddit.js';
import { scrapePostComments }from './scraper/reddit/post-comments.js';
import { resetRedditSession, performRedditLoginIfRequested } from './scraper/reddit/api.js';
import {
  appendPostSearchResults,    savePostSearchWorkbook,
  appendSubredditSearchResults,saveSubredditSearchWorkbook,
  appendSubredditPosts,        saveSubredditWorkbook,
  appendPostComments,          saveCommentsWorkbook,
} from './output/reddit-excel.js';

async function runPostSearch(page) {
  const keywords = await askKeywords();
  const limit    = await askLimit('posts');
  const { sort, time } = await askRedditSortTime();
  const wb = new ExcelJS.Workbook();
  for (const kw of keywords) {
    try { appendPostSearchResults(wb, await searchRedditPosts(page, kw, limit, sort, time)); }
    catch (err) { console.error(`  ✖ "${kw}": ${err.message}`); }
    await sleep(1_200);
  }
  await savePostSearchWorkbook(wb, keywords[0].replace(/\s+/g,'_').slice(0,40));
}

async function runSubSearch(page) {
  const keywords = await askKeywords();
  const limit    = await askLimit('subreddits');
  const wb = new ExcelJS.Workbook();
  for (const kw of keywords) {
    try { appendSubredditSearchResults(wb, await searchRedditSubreddits(page, kw, limit)); }
    catch (err) { console.error(`  ✖ "${kw}": ${err.message}`); }
    await sleep(1_200);
  }
  await saveSubredditSearchWorkbook(wb, keywords[0].replace(/\s+/g,'_').slice(0,40));
}

async function runSubreddit(page) {
  const subs  = await askSubredditInput();
  const limit = await askLimit('posts');
  const { sort, time } = await askSubredditSort();
  const wb = new ExcelJS.Workbook();
  for (const s of subs) {
    try {
      const { meta, posts } = await scrapeSubreddit(page, s, limit, sort, time);
      appendSubredditPosts(wb, meta, posts);
    } catch (err) { console.error(`  ✖ "${s}": ${err.message}`); }
    await sleep(1_200);
  }
  await saveSubredditWorkbook(wb, subs[0].replace(/[\s/]+/g,'_').slice(0,40));
}

async function runComments(page) {
  const urls  = await askPostUrls();
  const limit = await askLimit('comments');
  const wb    = new ExcelJS.Workbook();
  for (const url of urls) {
    try {
      const { post, comments } = await scrapePostComments(page, url, limit);
      appendPostComments(wb, post, comments);
    } catch (err) { console.error(`  ✖ "${url}": ${err.message}`); }
    await sleep(1_200);
  }
  await saveCommentsWorkbook(wb, `${urls.length}_posts`);
}

export async function runRedditSession(page, isHeadless = false) {
  resetRedditSession();
  await performRedditLoginIfRequested(page, isHeadless); // reset so navigation always happens fresh
  const mode = await askRedditMode();
  console.log('');
  switch (mode) {
    case 'search-posts': await runPostSearch(page);  break;
    case 'search-subs':  await runSubSearch(page);   break;
    case 'subreddit':    await runSubreddit(page);   break;
    case 'comments':     await runComments(page);    break;
  }
  console.log('\nReddit session complete.');
}
