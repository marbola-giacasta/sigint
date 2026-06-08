/**
 * src/scraper/instagram-search.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Scrapes Instagram posts by keyword/hashtag.
 *
 * Strategy: scroll the explore/search grid and extract ALL data visible
 * on screen from the grid itself — no per-post page navigation needed.
 * Each post card exposes: shortcode (from href), author (from aria-label or
 * nearby text), image URL (from src), and partial caption (from alt text).
 *
 * This is 50x faster than navigating to each post individually.
 */

import { sleep }  from '../utils/sleep.js';
import { safeGoto, dismissPopups } from '../browser/page.js';

const IG_BASE = 'https://www.instagram.com';

export async function scrapeInstagramSearch(
  page: any,
  keyword: string,
  limitConfig: any,
): Promise<any[]> {
  const isHashtag = keyword.startsWith('#');
  const tag       = keyword.replace(/^#/, '').trim();
  const target    = limitConfig.mode === 'all' ? 150 : (limitConfig.count ?? 50);

  console.log(`  ┌─ Instagram Search ─────────────────────────────`);
  console.log(`  │  Keyword : "${keyword}" ${isHashtag ? '(hashtag)' : '(keyword search)'}`);
  console.log(`  │  Target  : ${target} posts`);
  console.log(`  └───────────────────────────────────────────────────`);

  const startTime = Date.now();

  const url = isHashtag
    ? `${IG_BASE}/explore/tags/${encodeURIComponent(tag)}/`
    : `${IG_BASE}/explore/search/keyword/?q=${encodeURIComponent(tag)}`;

  await safeGoto(page, url);
  await sleep(3000);
  await dismissPopups(page);
  await sleep(1500);

  const seenCodes = new Set<string>();
  const results: any[] = [];

  // Extract all post data directly from the grid — no per-post navigation
  const extractGrid = async (): Promise<any[]> => {
    return page.evaluate((igBase: string) => {
      const posts: any[] = [];
      // Each post is an <a href="/p/SHORTCODE/"> containing an <img>
      document.querySelectorAll('a[href*="/p/"]').forEach((a: any) => {
        const m = a.href?.match(/\/p\/([A-Za-z0-9_-]+)/);
        if (!m) return;
        const shortcode = m[1];
        const img       = a.querySelector('img');
        const imageUrl  = img?.src || '';
        // Caption is often in the img alt text
        const caption   = img?.alt || '';
        // Author: try various places Instagram puts it
        // 1. aria-label on the link itself
        // 2. nearby span with username class  
        // 3. parent article's header link
        let author = '';
        const ariaLabel = a.getAttribute('aria-label') || '';
        // aria-label format: "Photo by USERNAME on..."
        const ariaMatch = ariaLabel.match(/by\s+([^\s,]+)/i);
        if (ariaMatch) { author = ariaMatch[1]; }
        if (!author) {
          // Look for username in sibling/parent elements (explore grid)
          const article = a.closest('article') || a.closest('div[role="button"]')?.parentElement;
          if (article) {
            const headerLink = article.querySelector('header a, a[role="link"]:not([href*="/p/"])');
            if (headerLink) {
              const hrefMatch = headerLink.getAttribute('href')?.match(/\/([^/?]+)\/?$/);
              if (hrefMatch) author = hrefMatch[1];
            }
          }
        }
        // Timestamp: sometimes in time element nearby
        const timeEl = a.closest('article')?.querySelector('time') as any;
        const timestamp = timeEl?.getAttribute('datetime') || '';
        // Likes: sometimes shown as overlay text
        const overlaySpans = Array.from(a.querySelectorAll('span'));
        const likeSpan = (overlaySpans as any[]).find((s: any) => s.textContent?.match(/^[\d,.]+[KkMm]?$/));
        const likes = (likeSpan as any)?.textContent?.trim() || '';
        posts.push({ shortcode, imageUrl, caption, author, timestamp, likes, url: `${igBase}/p/${shortcode}/` });
      });
      return posts;
    }, IG_BASE).catch(() => []);
  };

  let scrolls = 0;
  const maxScrolls = Math.ceil(target / 9) + 4;

  while (results.length < target && scrolls < maxScrolls) {
    const posts = await extractGrid();
    let added = 0;
    for (const p of posts) {
      if (!seenCodes.has(p.shortcode)) {
        seenCodes.add(p.shortcode);
        results.push(p);
        added++;
        if (results.length >= target) break;
      }
    }
    if (added > 0) {
      console.log(`  ↓  Scroll ${String(scrolls+1).padStart(2,'0')} — +${added} new → ${results.length} total`);
    }
    if (results.length >= target) break;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(1800);
    scrolls++;
    if (scrolls > 3 && results.length === 0) {
      console.log(`  ⚠  No posts found after ${scrolls} scrolls. Ensure you are logged into Instagram.`);
      break;
    }
  }

  // Log sample
  results.slice(0, 5).forEach((p: any, i: number) => {
    const auth = String(p.author || '?').slice(0, 18).padEnd(18);
    const cap  = String(p.caption || '').replace(/\n/g, ' ').slice(0, 45);
    console.log(`  ${String(i+1).padStart(3,' ')}  @${auth}  ${cap || '[no caption]'}`);
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ✓ "${keyword}" — ${results.length} posts in ${elapsed}s`);
  return results;
}
