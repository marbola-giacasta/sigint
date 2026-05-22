/**
 * src/scraper/youtube/comments.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original comments.mjs.
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
 * src/scraper/youtube/comments.mjs — Puppeteer edition
 * ─────────────────────────────────────────────────────────────────────────────
 * Root-cause fix: YouTube uses a virtual DOM renderer that keeps only ~20
 * comments in the DOM at a time (old ones removed, new ones added as you
 * scroll).  Watching the DOM *count* to detect new content therefore NEVER
 * works reliably after the first batch — the count stays the same while the
 * actual comment text rotates.
 *
 * Correct strategy
 * ─────────────────
 * 1. After every scroll, extract whatever is currently in the DOM.
 * 2. Add to a deduplication Map (author+text key).
 * 3. Increment noNewCount ONLY when seen.size didn't grow.
 * 4. Sleep a fixed amount between scrolls (no DOM-count polling).
 * 5. Stop when target reached OR noNewCount hits threshold (15).
 * 6. No hard scroll-count ceiling — let the Map fill up.
 */

import { CONFIG }                  from '../../config.js';
import { sleep }                   from '../../utils/sleep.js';
import { applyLimit }              from '../../utils/limit.js';
import { dismissPopups, handleConsentGate } from '../../browser/page.js';
import { createResponseCollector } from '../interceptor.js';

const YT = CONFIG.youtube;

// ── Metadata ──────────────────────────────────────────────────────────────────

async function extractVideoMeta(page) {
  return page.evaluate(() => {
    const pr = (window as any).ytInitialPlayerResponse ?? {};
    const yd = (window as any).ytInitialData ?? {};
    const det  = pr.videoDetails ?? {};
    const micro = pr.microformat?.playerMicroformatRenderer ?? {};
    const conts = yd.contents?.twoColumnWatchNextResults?.results?.results?.contents ?? [];
    const pri   = conts.find(c => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer ?? {};
    const sec   = conts.find(c => c.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer ?? {};
    return {
      title:        det.title  ?? '',
      channelName:  det.author ?? '',
      viewCount:    pri.viewCount?.videoViewCountRenderer?.viewCount?.simpleText ?? '',
      likeCount:    pri.videoActions?.menuRenderer?.topLevelButtons
                      ?.find(b => b.segmentedLikeDislikeButtonViewModel)
                      ?.segmentedLikeDislikeButtonViewModel?.likeButtonViewModel
                      ?.likeButtonViewModel?.toggleButtonViewModel
                      ?.toggleButtonViewModel?.defaultButtonViewModel
                      ?.buttonViewModel?.accessibilityText ?? '',
      uploadDate:   micro.publishDate ?? '',
      description:  (sec.attributedDescription?.content ?? micro.description?.simpleText ?? det.shortDescription ?? '').slice(0, 2000),
      commentCount: det.commentCount ?? '',
    };
  }).catch(() => ({ title:'', channelName:'', viewCount:'', likeCount:'', uploadDate:'', description:'', commentCount:'' }));
}

// ── CAPTCHA / consent wait ────────────────────────────────────────────────────

async function waitForVideoPage(page, timeoutMs = 180_000) {
  const isLoaded = async () => page.evaluate(() => !!(window as any).ytInitialPlayerResponse?.videoDetails?.videoId).catch(() => false);
  if (await isLoaded()) return true;
  console.log('\n  ⏳  YouTube has not loaded the video yet.');
  console.log('     Solve any CAPTCHA or consent screen in the browser window.');
  console.log(`     Waiting up to ${timeoutMs / 60_000} minutes...\n`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2_000);
    if (await isLoaded()) { console.log('  ✓  Video page confirmed.\n'); return true; }
  }
  return false;
}

// ── Bulk DOM extraction (single evaluate call — fast) ─────────────────────────

/**
 * Reads ALL currently rendered comment elements in one page.evaluate() call.
 * This is faster than calling locator().textContent() per element and avoids
 * timeout issues when virtual DOM keeps many stale elements in memory.
 */
async function extractVisibleComments(page, videoUrl, videoTitle) {
  return page.evaluate((u, t) => {
    const out = [];

    function addComment(author, text, likes, date, isReply) {
      text = (text || '').trim();
      if (!text || text.length < 2) return;
      out.push({
        videoUrl: u, videoTitle: t,
        commentIndex: out.length,
        author: (author || '').trim().replace(/\n/g, ' '),
        text,
        likes: (likes || '0').trim().replace(/[^0-9KMB,.]/gi, '') || '0',
        date:  (date  || '').trim(),
        replyCount: 0, isReply: isReply ? 'yes' : 'no', parentAuthor: '',
      });
    }

    // ── Strategy A: yt-comment-view-model (2024+ YouTube) ──────────────
    const modern = document.querySelectorAll('yt-comment-view-model');
    if (modern.length > 0) {
      modern.forEach(el => {
        const textEl = el.querySelector('yt-attributed-string[user-input], #content-text, yt-attributed-string');
        const text   = textEl?.textContent ?? '';
        const author = el.querySelector('yt-dynamic-text-view-model, #author-text, [id*="author"]')?.textContent ?? '';
        const likes  = el.querySelector('#vote-count-middle, [id*="vote-count"]')?.textContent ?? '0';
        const date   = el.querySelector('[class*="published"], [class*="time"], .published-time-text')?.textContent ?? '';
        const isReply = !!el.closest('ytd-comment-replies-renderer, [id="replies"]');
        addComment(author, text, likes, date, isReply);
      });
      if (out.length > 0) return out;
    }

    // ── Strategy B: ytd-comment-renderer (legacy) ──────────────────────
    const legacy = document.querySelectorAll('ytd-comment-renderer');
    if (legacy.length > 0) {
      legacy.forEach(el => {
        const text   = el.querySelector('#content-text')?.textContent ?? '';
        const author = el.querySelector('#author-text span, #author-text')?.textContent ?? '';
        const likes  = el.querySelector('#vote-count-middle')?.textContent ?? '0';
        const date   = el.querySelector('.published-time-text a, #published-time-text a')?.textContent ?? '';
        const isReply = !!el.closest('#replies');
        addComment(author, text, likes, date, isReply);
      });
      if (out.length > 0) return out;
    }

    // ── Strategy C: ytd-comment-thread-renderer ────────────────────────
    document.querySelectorAll('ytd-comment-thread-renderer').forEach(el => {
      const text   = el.querySelector('#content-text')?.textContent ?? '';
      const author = el.querySelector('#author-text')?.textContent ?? '';
      const likes  = el.querySelector('#vote-count-middle')?.textContent ?? '0';
      const date   = el.querySelector('.published-time-text a')?.textContent ?? '';
      addComment(author, text, likes, date, false);
    });
    if (out.length > 0) return out;

    // ── Strategy D: broad #content-text fallback ───────────────────────
    document.querySelectorAll('#comments #content-text, ytd-comments #content-text').forEach(el => {
      const parent = el.closest('[id="comment"], ytd-comment-renderer') ?? el.parentElement;
      const author = parent?.querySelector('#author-text, [class*="author"]')?.textContent ?? '';
      addComment(author, el.textContent ?? '', '0', '', false);
    });

    return out;
  }, videoUrl, videoTitle).catch(() => []);
}

// ── Scroll to make comment section appear ─────────────────────────────────────

async function scrollUntilCommentsVisible(page) {
  // scrollIntoView on the container first
  await page.evaluate(() => {
    const el = document.querySelector('ytd-comments, #comments');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }).catch(() => {});
  await sleep(1_200);

  const STAGES = [400, 800, 1300, 1900, 2700, 3800, 5200];
  for (const y of STAGES) {
    await page.evaluate(pos => window.scrollTo({ top: pos, behavior: 'smooth' }), y).catch(() => {});
    await sleep(1_000);
    const count = await page.evaluate(() =>
      document.querySelectorAll('ytd-comment-renderer, yt-comment-view-model, ytd-comment-thread-renderer').length
    ).catch(() => 0);
    if (count > 0) { console.log(`  Comment elements found (${count}) at scroll ${y}px ✓`); return true; }
  }
  return false;
}

// ── API bonus ─────────────────────────────────────────────────────────────────

function transformNext(json) {
  const nodes = [];
  function walk(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const t = item?.commentThreadRenderer;
      if (!t) continue;
      const cr = t.comment?.commentRenderer;
      if (cr) nodes.push({ cr, isReply: false, parentAuthor: '' });
      (t.replies?.commentRepliesRenderer?.contents ?? []).forEach(r => {
        const rcr = r?.commentRenderer;
        if (rcr) nodes.push({ cr: rcr, isReply: true, parentAuthor: cr?.authorText?.simpleText ?? '' });
      });
    }
  }
  for (const ep of ((json as any)?.onResponseReceivedEndpoints ?? [])) {
    walk(ep?.reloadContinuationItemsCommand?.continuationItems);
    walk(ep?.appendContinuationItemsAction?.continuationItems);
  }
  return nodes.length ? nodes : null;
}

function normaliseNode({ cr, isReply, parentAuthor }, videoUrl, videoTitle, index) {
  const text = cr?.contentText?.runs?.map(r => r.text).join('') ?? cr?.contentText?.simpleText ?? '';
  if (!text) return null;
  return { videoUrl, videoTitle, commentIndex: index, author: cr.authorText?.simpleText ?? '', text,
           likes: cr.voteCount?.simpleText ?? '0', date: cr.publishedTimeText?.runs?.[0]?.text ?? cr.publishedTimeText?.simpleText ?? '',
           replyCount: cr.replyCount ?? 0, isReply: isReply ? 'yes' : 'no', parentAuthor };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function scrapeYoutubeComments(page, videoUrl, limitConfig) {
  console.log(`  → YouTube comments: ${videoUrl}`);

  const collector = createResponseCollector(page, url => url.includes('youtubei/v1/next'), transformNext);

  await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
  await sleep(2_000);
  await handleConsentGate(page);
  await dismissPopups(page);

  const loaded = await waitForVideoPage(page);
  if (!loaded) {
    collector.stop();
    console.log('  ✖  Timed out waiting for the video page.');
    return { meta: { videoUrl, title:'', channelName:'', viewCount:'', likeCount:'', uploadDate:'', description:'', commentCount:'' }, comments: [] };
  }

  await sleep(500);
  const meta = await extractVideoMeta(page);
  console.log(`  Video: "${(meta as any).title}"`);

  console.log('  Scrolling to comments section...');
  const found = await scrollUntilCommentsVisible(page);
  if (!found) {
    const tags = await page.evaluate(() => {
      const m = {}; document.querySelectorAll('*').forEach(e => { const t = e.tagName.toLowerCase(); if (t.startsWith('yt')) m[t]=(m[t]||0)+1; });
      return Object.entries(m).filter(([k])=>k.includes('comment')||k.includes('ytd')).sort((a: any,b: any)=>(b[1] as number)-(a[1] as number)).slice(0,15);
    }).catch(()=>[]);
    console.log('  ⚠  No comment elements found.');
    if (tags.length) console.log('     DOM:', tags.map(([k,v])=>`${k}×${v}`).join(', '));
    console.log('     Possible: comments disabled, sign-in required, or page failed to load.');
    collector.stop();
    return { meta: { ...meta, videoUrl }, comments: [] };
  }

  await sleep(1_500);

  // ── Pagination loop ───────────────────────────────────────────────────
  // KEY FIX: we track seen.size growth — NOT DOM element count.
  // YouTube's virtual renderer recycles DOM nodes so the count stays flat.
  const target      = limitConfig.mode === 'all' ? 9_999 : (limitConfig.count ?? 100);
  const seen        = new Map();
  let noNewCount    = 0;
  let scrollsDone   = 0;
  const MAX_DRY     = 15;   // consecutive scrolls with no new comments → stop
  const SCROLL_WAIT = 2_200; // fixed wait after each scroll (ms)

  while (seen.size < target && noNewCount < MAX_DRY) {
    const before = seen.size;

    const visible = await extractVisibleComments(page, videoUrl, (meta as any).title);
    for (const c of visible) {
      const key = `${c.author}::${c.text}`;
      if (!seen.has(key)) seen.set(key, { ...c, commentIndex: seen.size });
    }

    process.stdout.write(`  Comments: ${seen.size} / ${target}  (scroll ${scrollsDone + 1}, dry: ${noNewCount})\r`);

    // Only count as dry if seen DIDN'T grow — DOM count is irrelevant
    noNewCount = seen.size === before ? noNewCount + 1 : 0;
    if (seen.size >= target) break;

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
    await sleep(SCROLL_WAIT);
    scrollsDone++;
  }

  collector.stop();
  process.stdout.write('\n');

  // Merge API bonus
  let apiCount = 0;
  for (const batch of collector.results) {
    if (!Array.isArray(batch)) continue;
    for (const node of batch) {
      const c = normaliseNode(node, videoUrl, (meta as any).title, seen.size);
      if (c) { const key = `${c.author}::${c.text}`; if (!seen.has(key)) { seen.set(key, c); apiCount++; } }
    }
  }
  if (apiCount > 0) console.log(`  + ${apiCount} merged from API`);

  const comments = applyLimit([...seen.values()], limitConfig);
  console.log(`  ✓ Collected ${comments.length} comment(s) from "${(meta as any).title}" (${scrollsDone} scrolls)`);
  return { meta: { ...meta, videoUrl }, comments };
}
