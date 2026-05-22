/**
 * src/scraper/youtube/channel-search.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original channel-search.mjs.
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
 * src/scraper/youtube/channel-search.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Searches YouTube for CHANNELS matching a keyword — not videos.
 *
 * How it works
 * ─────────────
 * YouTube's search filter parameter `sp=EgIQAg%3D%3D` restricts results to
 * channels only.  The page structure is identical to video search but the
 * result nodes are `channelRenderer` objects instead of `videoRenderer`.
 *
 * We read the first batch from (window as any).ytInitialData (embedded JSON), then
 * intercept `youtubei/v1/search` POST requests that fire as the user scrolls,
 * exactly like the video search scraper.
 *
 * Fields extracted per channel
 * ─────────────────────────────
 *   keyword | position | channelName | channelUrl | subscribers |
 *   videoCount | description | avatarUrl | verifiedBadge
 */

import { CONFIG }                              from '../../config.js';
import { sleep }                               from '../../utils/sleep.js';
import { applyLimit }                          from '../../utils/limit.js';
import { dismissPopups, retryOperation, handleConsentGate } from '../../browser/page.js';
import { createResponseCollector }             from '../interceptor.js';

const YT = CONFIG.youtube;

// YouTube search filter for "Channels" only
const CHANNELS_FILTER = 'EgIQAg%3D%3D';

// ── Normaliser ────────────────────────────────────────────────────────────────

/**
 * Converts a raw `channelRenderer` node into a flat row object.
 *
 * @param {any}    cr       — channelRenderer from ytInitialData or API
 * @param {string} keyword
 * @param {number} position — 0-based
 */
function normaliseChannelRenderer(cr, keyword, position) {
  if (!cr?.channelId && !cr?.navigationEndpoint) return null;

  const name = cr.title?.simpleText ?? cr.title?.runs?.map(r => r.text).join('') ?? '';

  // Canonical URL path e.g. "/@ChannelHandle" or "/channel/UCxxx"
  const urlPath =
    cr.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ??
    cr.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ?? '';
  const channelUrl = urlPath ? `https://www.youtube.com${urlPath}` : '';

  const subscribers =
    cr.subscriberCountText?.simpleText ??
    cr.subscriberCountText?.runs?.map(r => r.text).join('') ?? '';

  const videoCount =
    cr.videoCountText?.runs?.map(r => r.text).join('') ??
    cr.videoCountText?.simpleText ?? '';

  const description =
    cr.descriptionSnippet?.runs?.map(r => r.text).join('') ?? '';

  // Highest-res avatar thumbnail
  const avatars     = cr.thumbnail?.thumbnails ?? [];
  const avatarUrl   = avatars[avatars.length - 1]?.url ?? '';

  // Verified badge — present when channel has a checkmark
  const verified = !!(
    cr.ownerBadges?.some(b =>
      b.metadataBadgeRenderer?.style?.toLowerCase().includes('verified'),
    )
  );

  return {
    keyword,
    position,
    channelName:  name,
    channelUrl,
    subscribers,
    videoCount,
    description,
    avatarUrl,
    verified: verified ? 'Yes' : 'No',
  };
}

// ── ytInitialData extraction ──────────────────────────────────────────────────

function extractChannelRenderersFromInitial(ytData) {
  const renderers = [];
  const sections =
    ytData?.contents
      ?.twoColumnSearchResultsRenderer
      ?.primaryContents
      ?.sectionListRenderer
      ?.contents ?? [];

  for (const section of sections) {
    for (const item of (section?.itemSectionRenderer?.contents ?? [])) {
      if (item.channelRenderer) renderers.push(item.channelRenderer);
    }
  }
  return renderers;
}

// ── Continuation (scroll pagination) extraction ───────────────────────────────

function extractFromContinuation(json) {
  const renderers = [];
  for (const ep of ((json as any)?.onResponseReceivedCommands ?? [])) {
    const items = ep?.appendContinuationItemsAction?.continuationItems ?? [];
    for (const section of items) {
      for (const item of (section?.itemSectionRenderer?.contents ?? [])) {
        if (item.channelRenderer) renderers.push(item.channelRenderer);
      }
    }
  }
  return renderers.length ? renderers : null;
}

// ── Main scraper ──────────────────────────────────────────────────────────────

/**
 * @param {import('puppeteer-core').Page} page
 * @param {string} keyword
 * @param {object} limitConfig
 * @returns {Promise<object[]>}
 */
export async function scrapeYoutubeChannelSearch(page, keyword, limitConfig, filterParam = null) {
  console.log(`  → YouTube channel search: "${keyword}"${filterParam ? ' [with filter]' : ''}`);

  const rawCRs  = [];
  const seenIds = new Set();

  // Combine channels filter with any additional user filter
  const spParam  = filterParam ? `${CHANNELS_FILTER}${filterParam}` : CHANNELS_FILTER;
  const searchUrl = `${YT.baseUrl}/results?search_query=${encodeURIComponent(keyword)}&sp=${spParam}`;

  const collector = createResponseCollector(
    page,
    url => url.includes('youtubei/v1/search'),
    extractFromContinuation,
  );

  await sleep(1_000);
  await retryOperation(async () => {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  });
  await sleep(2_500);
  await handleConsentGate(page);
  await dismissPopups(page);

  // First batch from embedded ytInitialData
  const initialCRs = await page.evaluate(() => (window as any).ytInitialData ?? null)
    .then(d => d ? extractChannelRenderersFromInitial(d) : [])
    .catch(() => []);

  rawCRs.push(...initialCRs);
  console.log(`  Initial channels found: ${rawCRs.length}`);

  const target      = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 20);
  let   noNewCount  = 0;
  let   scrollsDone = 0;

  while (rawCRs.length < target && noNewCount < 3 && scrollsDone < YT.searchMaxScrolls) {
    const before = rawCRs.length;

    for (const batch of collector.results) {
      if (Array.isArray(batch)) rawCRs.push(...batch);
    }

    noNewCount = rawCRs.length === before ? noNewCount + 1 : 0;
    if (rawCRs.length >= target) break;

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await sleep(YT.searchScrollPauseMs);
    scrollsDone++;
  }

  collector.stop();

  // Deduplicate and normalise
  const results = [];
  for (const cr of rawCRs) {
    const id = cr?.channelId ?? cr?.navigationEndpoint?.browseEndpoint?.browseId ?? '';
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    const row = normaliseChannelRenderer(cr, keyword, results.length);
    if (row) results.push(row);
  }

  const limited = applyLimit(results, limitConfig);
  console.log(`  Found ${limited.length} channel(s) for "${keyword}"`);
  return limited;
}
