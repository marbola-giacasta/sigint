/**
 * TypeScript conversion — all logic identical to the working .mjs original.
 * Import paths use .js extension (TypeScript NodeNext requirement).
 * 'any' types used for API responses with complex/unknown shapes.
 */
/**
 * src/scraper/stories.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Stories scraping with a patient, multi-attempt strategy.
 *
 * Why stories are harder than posts
 * ──────────────────────────────────
 * • Stories require an active login session.
 * • The stories viewer is a full-screen overlay that renders slides one at a
 *   time.  The reels_media API call fires ONCE on load — if it's missed, no
 *   amount of DOM scraping will recover the data.
 * • Instagram sometimes fires the API call before Puppeteer's response listener
 *   is attached if the page transition is very fast.
 *
 * Strategy applied here
 * ─────────────────────
 * 1. Attach interceptor BEFORE navigating (same as before).
 * 2. Wait generously after load (storiesInitialWaitMs) for the API to fire.
 * 3. Dismiss all popups that might block the story viewer.
 * 4. Poll every storiesApiPollMs until we have results OR storiesApiTimeoutMs
 *    elapses — so a slow CDN or Instagram rate-limit still gets captured.
 * 5. If we still have nothing, click through each story slide up to
 *    storiesMaxScrollAttempts times, waiting between clicks — each slide
 *    transition can trigger a fresh API call.
 * 6. Fall back to scraping slide image/video elements directly from the DOM.
 */

import { CONFIG }                  from '../config.js';
import { sleep }                   from '../utils/sleep.js';
import { applyLimit }              from '../utils/limit.js';
import { dismissPopups }           from '../browser/page.js';
import { createResponseCollector } from './interceptor.js';

const IG = CONFIG.instagram;

// ── Normaliser ────────────────────────────────────────────────────────────────

function normaliseStory(item, idx) {
  // Prefer video URL for clips, image URL for photo stories
  const imageUrl =
    item.video_versions?.[0]?.url                  ??   // video clip / reel
    item.image_versions2?.candidates?.[0]?.url     ??   // photo story
    '';

  return {
    id:            String(item.pk ?? item.id ?? `story_${idx}`),
    shortcode:     item.code ?? '',
    imageUrl,
    isVideo:       Array.isArray(item.video_versions) && item.video_versions.length > 0,
    timestamp:     item.taken_at ? new Date(item.taken_at * 1_000).toISOString() : '',
    description:   item.caption?.text ?? '',
    likes:         String(item.like_count    ?? ''),
    commentsCount: String(item.comment_count ?? ''),
    comments:      [],
  };
}

// ── Interceptor match ─────────────────────────────────────────────────────────

function matchStoriesUrl(url) {
  return (
    url.includes('/reels_media/')  ||
    url.includes('/reel/feed/')    ||
    url.includes('/feed/reels/')   ||
    (url.includes('/stories/') && url.includes('/api/'))
  );
}

function extractStories(json) {
  // api/v1 reels_media — keyed by user ID
  const reels = json?.reels_media ?? json?.reels;
  if (reels) {
    const key = Object.keys(reels)[0];
    if (key && Array.isArray(reels[key]?.items)) return reels[key].items;
  }
  if (Array.isArray((json as any)?.items)) return (json as any).items;
  return null;
}

// ── Patient polling helper ────────────────────────────────────────────────────

/**
 * Waits up to `timeoutMs` (polling every `intervalMs`) for `collector.results`
 * to be non-empty, then returns.
 */
async function waitForResults(collector, timeoutMs, intervalMs) {
  const start = Date.now();
  while (collector.results.length === 0 && Date.now() - start < timeoutMs) {
    await sleep(intervalMs);
  }
}

// ── Slide-advance helper ──────────────────────────────────────────────────────

/**
 * Clicks the "next slide" button in the story viewer up to `maxAttempts`
 * times, pausing between each click.  Each transition can trigger a new
 * reels_media API response for the next batch of stories.
 */
async function scrollThroughSlides(page, maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    const clicked = await page.evaluate(() => {
      // Instagram renders story navigation as a button or clickable div on the right
      const selectors = [
        'button[aria-label="Next"]',
        'button[aria-label="next"]',
        '[class*="coreSpriteRightChevron"]',
        '[data-testid="story-see-all-link"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { (el as any).click(); return true; }
      }
      // Fallback: click on the right half of the story overlay
      const overlay = document.querySelector('section[class*="Story"], div[class*="Story"]');
      if (overlay) {
        const rect = overlay.getBoundingClientRect();
        const x    = rect.right - 30;
        const y    = rect.top + rect.height / 2;
        (document.elementFromPoint(x, y) as any)?.click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (!clicked) break;
    await sleep(IG.storiesScrollWaitMs);
  }
}

// ── Main scraper ──────────────────────────────────────────────────────────────

/**
 * Scrapes stories for `username`.  Pass `userId` (from profile summary) for
 * tighter API URL matching; the scraper works without it but is more precise
 * when provided.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} username
 * @param {string} [userId]
 * @param {object} limitConfig
 * @returns {Promise<any[]>}
 */
export async function scrapeStories(page, username, userId, limitConfig) {
  console.log(`  → Fetching stories for ${username}...`);

  const stories = [];

  // Build match function — if we have a userId, also match the direct reels URL
  const matchFn = url =>
    matchStoriesUrl(url) ||
    (userId && url.includes(`reel_ids=${userId}`)) ||
    (userId && url.includes(`/feed/reels_tray/`));

  const collector = createResponseCollector(page, matchFn, extractStories);

  try {
    await page.goto(
      `${CONFIG.instagram.baseUrl}/stories/${username}/`,
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );

    // ── Step 1: generous initial wait ────────────────────────────────────
    await sleep(IG.storiesInitialWaitMs);
    await dismissPopups(page);
    await sleep(1_000);

    // ── Step 2: poll patiently for the first API response ─────────────
    if (collector.results.length === 0) {
      console.log('  Stories: waiting for API response...');
      await waitForResults(collector, IG.storiesApiTimeoutMs, IG.storiesApiPollMs);
    }

    // ── Step 3: click through slides to trigger more API calls ─────────
    if (collector.results.length > 0) {
      await scrollThroughSlides(page, IG.storiesMaxScrollAttempts);
      await sleep(1_500); // let any triggered API calls land
    }

    // ── Flatten all intercepted batches ───────────────────────────────
    for (const batch of collector.results) {
      if (!Array.isArray(batch)) continue;
      for (const item of batch) {
        if (item) stories.push(normaliseStory(item, stories.length));
      }
    }

    // ── Step 4: DOM fallback if API never fired ────────────────────────
    if (stories.length === 0) {
      console.log('  Stories: API gave no data — trying DOM fallback...');
      const domItems = await page.evaluate(() => {
        const out = [];
        const candidates = document.querySelectorAll(
          'section img, div[role="dialog"] img, video source, video',
        );
        candidates.forEach((el, i) => {
          const src = (el as any).src ?? el.getAttribute('src') ?? (el as any).currentSrc ?? '';
          if (src && !src.startsWith('data:')) {
            out.push({
              id:            `dom_story_${i}`,
              shortcode:     '',
              imageUrl:      src,
              isVideo:       el.tagName === 'VIDEO' || el.tagName === 'SOURCE',
              timestamp:     '',
              description:   (el as any).alt ?? '',
              likes:         '',
              commentsCount: '',
              comments:      [],
            });
          }
        });
        return out;
      }).catch(() => []);

      stories.push(...domItems);
    }

  } catch (err) {
    console.log(`  ⚠  Stories for "${username}": ${err.message}`);
  }

  collector.stop();

  const result = applyLimit(stories, limitConfig).map((s, i) => ({ ...s, index: i }));
  console.log(`  → Found ${result.length} storie(s) for ${username}.`);
  return result;
}
