/**
 * youtube-session.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original youtube-session.mjs.
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
  askYoutubeMode, askKeywords, askVideoUrls, askChannelUrls,
  askResultsLimit, askCommentsLimit, askChannelVideosLimit,
  askSearchFilter, askChannelSortFilter,
} from './cli/youtube-prompts.js';
import { scrapeYoutubeSearch }        from './scraper/youtube/search.js';
import { scrapeYoutubeComments }      from './scraper/youtube/comments.js';
import { scrapeYoutubeChannelSearch } from './scraper/youtube/channel-search.js';
import { scrapeChannelVideos }        from './scraper/youtube/channel-videos.js';
import {
  appendSearchResults,       saveSearchWorkbook,
  appendVideoComments,       saveCommentsWorkbook,
  appendChannelSearchResults,saveChannelSearchWorkbook,
  appendChannelVideos,       saveChannelVideosWorkbook,
} from './output/youtube-excel.js';

const YT = CONFIG.youtube;

async function runYoutubeSearch(page) {
  const keywords    = await askKeywords();
  const limitConfig = await askResultsLimit();
  const filterParam = await askSearchFilter();
  const workbook    = new ExcelJS.Workbook();
  for (let i = 0; i < keywords.length; i++) {
    try { appendSearchResults(workbook, await scrapeYoutubeSearch(page, keywords[i], limitConfig, filterParam)); }
    catch (err) { console.error(`  ✖ "${keywords[i]}": ${err.message}`); }
    if (i < keywords.length - 1) { console.log(`  Pausing…`); await sleep(YT.batchPauseMs); }
  }
  await saveSearchWorkbook(workbook, keywords[0].replace(/\s+/g,'_').slice(0,40));
}

async function runChannelSearch(page) {
  const keywords    = await askKeywords();
  const limitConfig = await askResultsLimit();
  const filterParam = await askSearchFilter();
  const workbook    = new ExcelJS.Workbook();
  for (let i = 0; i < keywords.length; i++) {
    try { appendChannelSearchResults(workbook, await scrapeYoutubeChannelSearch(page, keywords[i], limitConfig, filterParam)); }
    catch (err) { console.error(`  ✖ "${keywords[i]}": ${err.message}`); }
    if (i < keywords.length - 1) { await sleep(YT.batchPauseMs); }
  }
  await saveChannelSearchWorkbook(workbook, keywords[0].replace(/\s+/g,'_').slice(0,40));
}

async function runChannelVideos(page) {
  const urls        = await askChannelUrls();
  const limitConfig = await askChannelVideosLimit();
  const sortParam   = await askChannelSortFilter();
  const workbook    = new ExcelJS.Workbook();
  for (let i = 0; i < urls.length; i++) {
    try {
      const { meta, videos } = await scrapeChannelVideos(page, urls[i], limitConfig, sortParam);
      appendChannelVideos(workbook, meta, videos);
    } catch (err) { console.error(`  ✖ "${urls[i]}": ${err.message}`); }
    if (i < urls.length - 1) { await sleep(YT.batchPauseMs); }
  }
  await saveChannelVideosWorkbook(workbook, `${urls.length}_channels`);
}

async function runYoutubeComments(page) {
  const urls        = await askVideoUrls();
  const limitConfig = await askCommentsLimit();
  const workbook    = new ExcelJS.Workbook();
  for (let i = 0; i < urls.length; i++) {
    try {
      const { meta, comments } = await scrapeYoutubeComments(page, urls[i], limitConfig);
      appendVideoComments(workbook, meta, comments);
    } catch (err) { console.error(`  ✖ "${urls[i]}": ${err.message}`); }
    if (i < urls.length - 1) { await sleep(YT.batchPauseMs); }
  }
  await saveCommentsWorkbook(workbook, `${urls.length}_videos`);
}

export async function runYoutubeSession(page) {
  const mode = await askYoutubeMode();
  console.log('');
  switch (mode) {
    case 'search':         await runYoutubeSearch(page);   break;
    case 'channel-search': await runChannelSearch(page);   break;
    case 'channel-videos': await runChannelVideos(page);   break;
    case 'comments':       await runYoutubeComments(page); break;
  }
  console.log('\nYouTube session complete.');
}
