/**
 * src/scraper/youtube/search.ts
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
 * src/scraper/youtube/search.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Scrapes YouTube search results for one keyword.
 *
 * Strategy
 * ─────────
 * • Navigate to https://www.youtube.com/results?search_query=KEYWORD
 * • Extract the initial batch from (window as any).ytInitialData (embedded JSON).
 * • Intercept https://www.youtube.com/youtubei/v1/search requests that fire
 *   when the user (us, via scrolling) reaches the bottom of the page.
 * • Keep scrolling until we have enough results or no new ones appear.
 *
 * Each result row contains:
 *   keyword, position, title, url, channelName, viewCount, duration,
 *   uploadDate, descriptionSnippet, thumbnailUrl
 */

import { CONFIG }                  from '../../config.js';
import { sleep }                   from '../../utils/sleep.js';
import { applyLimit }              from '../../utils/limit.js';
import { dismissPopups, handleConsentGate } from '../../browser/page.js';
import { createResponseCollector } from '../interceptor.js';

const YT = CONFIG.youtube;

// ── Normaliser ────────────────────────────────────────────────────────────────

/**
 * Extracts a plain object from a YouTube `videoRenderer` node.
 *
 * @param {any}    vr       — videoRenderer object from ytInitialData or API
 * @param {string} keyword
 * @param {number} position — 0-based index in results
 */
function normaliseVideoRenderer(vr, keyword, position) {
  if (!vr?.videoId) return null;

  const title  = vr.title?.runs?.map(r => r.text).join('') ??
                 vr.title?.simpleText ?? '';

  const channel = vr.longBylineText?.runs?.[0]?.text ??
                  vr.ownerText?.runs?.[0]?.text       ?? '';

  const viewCount = vr.viewCountText?.simpleText ??
                    vr.viewCountText?.runs?.map(r => r.text).join('') ?? '';

  const duration = vr.lengthText?.simpleText ?? '';

  const uploadDate = vr.publishedTimeText?.simpleText ?? '';

  const description =
    vr.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') ??
    vr.descriptionSnippet?.runs?.map(r => r.text).join('')                          ?? '';

  // Take the highest-res thumbnail
  const thumbnails  = vr.thumbnail?.thumbnails ?? [];
  const thumbnailUrl = thumbnails[thumbnails.length - 1]?.url ?? '';

  return {
    keyword,
    position,
    title,
    url:         `https://www.youtube.com/watch?v=${vr.videoId}`,
    channelName: channel,
    viewCount,
    duration,
    uploadDate,
    descriptionSnippet: description,
    thumbnailUrl,
  };
}

// ── ytInitialData extraction ──────────────────────────────────────────────────

/**
 * Walks the ytInitialData contents tree and returns all videoRenderer nodes.
 * YouTube nests results under several layers of renderer objects.
 */
function extractVideoRenderersFromYtData(ytData) {
  const renderers = [];

  // Standard search results path
  const sections =
    ytData?.contents
      ?.twoColumnSearchResultsRenderer
      ?.primaryContents
      ?.sectionListRenderer
      ?.contents ?? [];

  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents ?? [];
    for (const item of items) {
      if (item.videoRenderer) renderers.push(item.videoRenderer);
    }
  }

  return renderers;
}

/**
 * Same walk but for continuation API responses (youtubei/v1/search).
 */
function extractFromContinuation(json) {
  const renderers = [];
  const endpoints = (json as any)?.onResponseReceivedCommands ?? [];
  for (const ep of endpoints) {
    const items = ep?.appendContinuationItemsAction?.continuationItems ?? [];
    for (const section of items) {
      const contents = section?.itemSectionRenderer?.contents ?? [];
      for (const item of contents) {
        if (item.videoRenderer) renderers.push(item.videoRenderer);
      }
    }
  }
  return renderers.length ? renderers : null;
}

// ── Main scraper ──────────────────────────────────────────────────────────────

/**
 * Scrapes YouTube search results for `keyword` and returns normalised rows.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} keyword
 * @param {object} limitConfig   — { mode: 'all'|'specific', count: number|null }
 * @returns {Promise<object[]>}
 */
export async function scrapeYoutubeSearch(page, keyword, limitConfig, filterParam = null) {
  const startTime = Date.now();
  console.log(`  ┌─ YouTube Search ──────────────────────────────────`);
  console.log(`  │  Keyword  : "${keyword}"${filterParam ? ' [filtered: '+filterParam+']' : ''}`);
  console.log(`  │  Target   : ${limitConfig.mode === 'all' ? 'ALL available' : limitConfig.count + ' results'}`);
  console.log(`  └───────────────────────────────────────────────────`);

  const spPart    = filterParam ? `&sp=${filterParam}` : '';
  const searchUrl = `${YT.baseUrl}/results?search_query=${encodeURIComponent(keyword)}${spPart}`;
  const rawRenderers = [];

  // Intercept pagination API calls BEFORE navigating
  const collector = createResponseCollector(
    page,
    url => url.includes('youtubei/v1/search'),
    extractFromContinuation,
  );

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(2_500);
  await handleConsentGate(page);
  await dismissPopups(page);

  // ── Initial batch from embedded ytInitialData ─────────────────────────
  const initialRenderers = await page.evaluate(
    () => (window as any).ytInitialData ?? null,
  ).then(ytData => ytData ? extractVideoRenderersFromYtData(ytData) : []).catch(() => []);

  rawRenderers.push(...initialRenderers);
  console.log(`  Initial results: ${rawRenderers.length}`);

  const target     = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 20);
  let   noNewCount = 0;
  let   scrollsDone = 0;

  // ── Scroll to load more ────────────────────────────────────────────────
  while (rawRenderers.length < target && noNewCount < 3 && scrollsDone < YT.searchMaxScrolls) {
    const before = rawRenderers.length;

    for (const batch of collector.results) {
      if (Array.isArray(batch)) rawRenderers.push(...batch);
    }

    const newBatch = rawRenderers.length - before;
    noNewCount = newBatch === 0 ? noNewCount + 1 : 0;
    if (newBatch > 0) {
      console.log(`  ↓  Scroll ${String(scrollsDone+1).padStart(2,'0')} — +${newBatch} new → ${rawRenderers.length} total`);
    } else {
      console.log(`  ·  Scroll ${String(scrollsDone+1).padStart(2,'0')} — no new (dry ${noNewCount}/3)`);
    }
    if (rawRenderers.length >= target) break;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await sleep(YT.searchScrollPauseMs);
    scrollsDone++;
  }

  collector.stop();

  // Deduplicate by URL, then normalise
  const seenUrls = new Set();
  const results  = [];
  console.log(`  Processing ${rawRenderers.length} raw renderers...`);

  for (const vr of rawRenderers) {
    if (!vr?.videoId || seenUrls.has(vr.videoId)) continue;
    seenUrls.add(vr.videoId);
    const row = normaliseVideoRenderer(vr, keyword, results.length);
    if (row) {
      results.push(row);
      const n   = String(results.length).padStart(3,' ');
      const ttl = String(row.title       ||'').slice(0,52).padEnd(52);
      const ch  = String(row.channelName ||'').slice(0,22).padEnd(22);
      const vw  = String(row.viewCount   ||'').slice(0,14).padEnd(14);
      const dt  = String(row.uploadDate  ||'').slice(0,13);
      console.log(`  ${n}  ${ttl}  ${ch}  ${vw}  ${dt}`);
    }
  }

  const limited = applyLimit(results, limitConfig);
  const elapsed = ((Date.now() - startTime)/1000).toFixed(1);
  console.log(`  ✓ "${keyword}" — ${limited.length}/${results.length} results kept  (${scrollsDone} scrolls, ${elapsed}s)`);
  return limited;
}
