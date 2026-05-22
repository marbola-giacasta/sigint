/**
 * src/scraper/youtube/channel-videos.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original channel-videos.mjs.
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
 * src/scraper/youtube/channel-videos.mjs
 *
 * Mirrors search.mjs exactly — the only difference is:
 *   search  → intercepts "youtubei/v1/search",  reads ytInitialData search results
 *   channel → intercepts "youtubei/v1/browse",  reads ytInitialData channel grid
 *
 * This is the ONLY approach that works reliably. Any attempt to call the
 * browse API manually from page.evaluate(fetch()) gets an empty video grid
 * because YouTube's server-side bot detection blocks programmatic calls.
 * Natural navigation + response interception bypasses this entirely.
 */

import { CONFIG }                          from '../../config.js';
import { sleep }                           from '../../utils/sleep.js';
import { applyLimit }                      from '../../utils/limit.js';
import { dismissPopups, handleConsentGate, retryOperation } from '../../browser/page.js';
import { createResponseCollector }         from '../interceptor.js';

const YT = CONFIG.youtube;

// ─────────────────────────────────────────────────────────────────────────────
// URL normalisation
// ─────────────────────────────────────────────────────────────────────────────

export function normaliseChannelUrls(rawUrl) {
  const url = rawUrl.trim().replace(/\/$/, '')
    .replace(/\/(videos|shorts|streams|playlists|community|featured|about)(\/.*)?$/, '');
  return { root: url, videos: `${url}/videos` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Consent cookie — identical to how the other scrapers handle it
// ─────────────────────────────────────────────────────────────────────────────

let consentDone = false;

async function ensureConsent(page) {
  if (consentDone) return;
  try {
    await page.goto('https://www.youtube.com/?ucbcb=1',
      { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await sleep(800);
    await page.setCookie(
      { name: 'SOCS',    value: 'CAESEwgDEgk0NDE5NDMxNzIaAmVuIAEaBgiAo5e2Bg',
        domain: '.youtube.com', path: '/', secure: true },
      { name: 'CONSENT', value: 'YES+cb.20210328-17-p0.en+FX+' + Math.floor(Math.random() * 900 + 100),
        domain: '.youtube.com', path: '/', secure: true },
      { name: 'SOCS',    value: 'CAESEwgDEgk0NDE5NDMxNzIaAmVuIAEaBgiAo5e2Bg',
        domain: '.google.com',  path: '/', secure: true },
    );
    consentDone = true;
    console.log('  ✓  Consent cookie injected.');
  } catch (e) {
    console.log(`  ⚠  Consent injection failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel metadata (name + subscriber count)
// ─────────────────────────────────────────────────────────────────────────────

async function extractChannelMeta(page) {
  return page.evaluate(() => {
    const yd = (window as any).ytInitialData ?? {};
    const h  = yd.header?.c4TabbedHeaderRenderer
            ?? yd.header?.pageHeaderRenderer
            ?? {};
    const name =
      h.title ??
      h.pageTitle ??
      yd.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.title?.content ??
      document.querySelector('yt-formatted-string#channel-name, h1')?.textContent?.trim() ?? '';
    const subs =
      h.subscriberCountText?.simpleText ??
      h.subscriberCountText?.runs?.map(r => r.text).join('') ??
      document.querySelector('#subscriber-count')?.textContent?.trim() ?? '';
    return { name: name.trim(), subscribers: subs.trim() };
  }).catch(() => ({ name: '', subscribers: '' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract videoRenderers from ytInitialData on a channel /videos page
// This is the mirror of extractVideoRenderersFromYtData() in search.mjs
// ─────────────────────────────────────────────────────────────────────────────

function extractVRsFromYtData(ytData) {
  const vrs = [];
  if (!ytData) return vrs;

  const tabs = ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  for (const tab of tabs) {
    const tr      = tab?.tabRenderer;
    if (!tr) continue;
    const content = tr.content ?? {};

    // Modern layout: richGridRenderer
    for (const item of (content.richGridRenderer?.contents ?? [])) {
      const vr = item?.richItemRenderer?.content?.videoRenderer;
      if (vr?.videoId) vrs.push(vr);
      // Shelves inside sections
      for (const si of (item?.richSectionRenderer?.content?.richShelfRenderer?.contents ?? [])) {
        const svr = si?.richItemRenderer?.content?.videoRenderer;
        if (svr?.videoId) vrs.push(svr);
      }
    }

    // Older layout: sectionListRenderer → gridRenderer
    for (const sec of (content.sectionListRenderer?.contents ?? [])) {
      for (const c of (sec?.itemSectionRenderer?.contents ?? [])) {
        for (const gi of (c?.gridRenderer?.items ?? [])) {
          if (gi?.gridVideoRenderer?.videoId) vrs.push(gi.gridVideoRenderer);
        }
      }
    }

    if (vrs.length > 0) break; // stop at the first tab with videos
  }
  return vrs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract videoRenderers from a browse continuation response
// This is the mirror of extractFromContinuation() in search.mjs
// ─────────────────────────────────────────────────────────────────────────────

function extractFromBrowseContinuation(json) {
  const vrs = [];

  // Continuation response shape
  for (const action of ((json as any)?.onResponseReceivedActions ?? [])) {
    for (const item of (action?.appendContinuationItemsAction?.continuationItems ?? [])) {
      const vr  = item?.richItemRenderer?.content?.videoRenderer;
      const gvr = item?.gridVideoRenderer;
      if (vr?.videoId)  vrs.push(vr);
      if (gvr?.videoId) vrs.push(gvr);
    }
  }

  // Some responses wrap in a different shape
  if (vrs.length === 0) {
    const tabs = (json as any)?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
    for (const tab of tabs) {
      vrs.push(...extractVRsFromYtData(json));
    }
  }

  return vrs.length ? vrs : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalise a raw videoRenderer into a flat output row
// ─────────────────────────────────────────────────────────────────────────────

function normaliseVR(vr, channelName, channelUrl, position) {
  if (!vr?.videoId) return null;
  const title  = vr.title?.runs?.map(r => r.text).join('') ?? vr.title?.simpleText ?? '';
  const thumbs = vr.thumbnail?.thumbnails ?? [];
  return {
    channelName, channelUrl, position, title,
    videoUrl:           `https://www.youtube.com/watch?v=${vr.videoId}`,
    viewCount:          vr.viewCountText?.simpleText ?? vr.viewCountText?.runs?.map(r => r.text).join('') ?? '',
    duration:           vr.lengthText?.simpleText ?? '',
    uploadDate:         vr.publishedTimeText?.simpleText ?? vr.dateText?.simpleText ?? '',
    descriptionSnippet: vr.descriptionSnippet?.runs?.map(r => r.text).join('') ?? '',
    thumbnailUrl:       thumbs[thumbs.length - 1]?.url ?? '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main scraper — identical structure to scrapeYoutubeSearch()
// ─────────────────────────────────────────────────────────────────────────────

export async function scrapeChannelVideos(page, channelUrl, limitConfig, sortParam = null) {
  const { videos: videosUrl } = normaliseChannelUrls(channelUrl);
  console.log(`  → Channel videos: ${videosUrl}`);

  // Step 1: inject consent cookie (same as other YT scrapers)
  await ensureConsent(page);
  await sleep(400);

  const rawVRs = [];

  // Step 2: attach interceptor BEFORE navigating
  // Mirrors: createResponseCollector(page, url => url.includes('youtubei/v1/search'), ...)
  const collector = createResponseCollector(
    page,
    url => url.includes('youtubei/v1/browse'),
    extractFromBrowseContinuation,
  );

  // Step 3: navigate — YouTube fires browse API calls naturally during page load
  // Mirrors: await page.goto(searchUrl, { waitUntil: 'domcontentloaded', ... })
  await retryOperation(async () => {
    await page.goto(videosUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  });
  await sleep(2_500);
  await handleConsentGate(page);
  await dismissPopups(page);

  // Channel metadata
  const { name: channelName, subscribers } = await extractChannelMeta(page);
  const displayName = channelName || channelUrl;
  console.log(`  Channel: "${displayName}"  ${subscribers ? `(${subscribers})` : ''}`);

  // Step 4: read ytInitialData for the first batch
  // Mirrors: const initialRenderers = await page.evaluate(() => (window as any).ytInitialData ?? null)...
  const initialVRs = await page.evaluate(() => (window as any).ytInitialData ?? null)
    .then(d => d ? extractVRsFromYtData(d) : [])
    .catch(() => []);

  rawVRs.push(...initialVRs);
  console.log(`  Initial videos: ${rawVRs.length}`);

  const target      = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 30);
  let   noNewCount  = 0;
  let   scrollsDone = 0;

  // Step 5: scroll to paginate — mirrors search.mjs scroll loop exactly
  while (rawVRs.length < target && noNewCount < 5 && scrollsDone < YT.searchMaxScrolls * 2) {
    const before = rawVRs.length;

    for (const batch of collector.results) {
      if (Array.isArray(batch)) rawVRs.push(...batch);
    }

    noNewCount = rawVRs.length === before ? noNewCount + 1 : 0;
    if (rawVRs.length >= target) break;

    process.stdout.write(`  Videos: ${rawVRs.length}  (scroll ${scrollsDone + 1})\r`);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await sleep(YT.searchScrollPauseMs + 500);
    scrollsDone++;
  }

  collector.stop();
  process.stdout.write('\n');

  // Step 6: deduplicate and normalise — mirrors search.mjs dedup block
  const seenIds = new Set();
  const videos  = [];

  for (const vr of rawVRs) {
    if (!vr?.videoId || seenIds.has(vr.videoId)) continue;
    seenIds.add(vr.videoId);
    const row = normaliseVR(vr, displayName, channelUrl, videos.length);
    if (row) videos.push(row);
  }

  const limited = applyLimit(videos, limitConfig);
  console.log(`  ✓ Collected ${limited.length} video(s) from "${displayName}"`);
  return {
    meta: { channelName: displayName, channelUrl: videosUrl, subscribers },
    videos: limited,
  };
}
