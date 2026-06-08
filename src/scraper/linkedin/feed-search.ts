/**
 * src/scraper/linkedin/feed-search.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Scrapes LinkedIn feed/content posts by keyword.
 *
 * STRATEGY:
 *   Navigate to linkedin.com/search/results/content/?keywords={keyword}
 *   and extract post cards from the DOM. LinkedIn renders posts as article
 *   elements; we pull author, headline, text, likes, comments, timestamp, URL.
 *
 * REQUIREMENTS:
 *   Browser must be logged into LinkedIn. Use "Login LinkedIn" in the
 *   Browser panel before running any LinkedIn scrape.
 */

import { sleep }                   from '../../utils/sleep.js';
import { safeGoto, dismissPopups } from '../../browser/page.js';

const LI_BASE = 'https://www.linkedin.com';

/** A single LinkedIn feed post */
export interface LinkedInPost {
  author:    string;
  headline:  string;
  text:      string;
  likes:     string;
  comments:  string;
  timestamp: string;
  url:       string;
  authorUrl: string;
}

/**
 * Search LinkedIn feed for posts matching keyword.
 * @param page        Puppeteer page, must be logged in
 * @param keyword     Search term, e.g. "AI regulation" or "#fintech"
 * @param limitConfig { mode:'all'|'count', count?:number }
 */
export async function scrapeLinkedInFeed(
  page: any,
  keyword: string,
  limitConfig: { mode: string; count?: number | null },
): Promise<LinkedInPost[]> {

  const target = limitConfig.mode === 'all' ? 100 : (limitConfig.count ?? 50);

  console.log(`  ┌─ LinkedIn Feed Search ──────────────────────────`);
  console.log(`  │  Keyword : "${keyword}"`);
  console.log(`  │  Target  : ${target} posts`);
  console.log(`  └───────────────────────────────────────────────────`);

  const t0 = Date.now();

  await safeGoto(page,
    `${LI_BASE}/search/results/content/?keywords=${encodeURIComponent(keyword)}&sortBy=date_posted`
  );
  await sleep(2500);
  await dismissPopups(page);
  await sleep(1000);

  if (page.url().includes('/login') || page.url().includes('/uas/login')) {
    console.log('  ⚠  Not logged into LinkedIn.');
    return [];
  }

  const seen    = new Set<string>();
  const results: LinkedInPost[] = [];
  let   scrolls = 0;

  const extract = (): Promise<LinkedInPost[]> => page.evaluate((): any[] => {
    const out: any[] = [];
    document.querySelectorAll(
      '.reusable-search__result-container, .search-results__list > li'
    ).forEach((card: any) => {
      const q = (sel: string) => card.querySelector(sel)?.textContent?.trim() ?? '';
      const a = (sel: string, attr: string) => card.querySelector(sel)?.getAttribute(attr) ?? '';

      const author    = q('.entity-result__title-text, .update-components-actor__name').split('\n')[0];
      const headline  = q('.entity-result__primary-subtitle, .update-components-actor__description').split('\n')[0];
      const text      = q('.entity-result__summary, .update-components-text, .feed-shared-update-v2__description').slice(0, 500);
      const likes     = q('[aria-label*="reaction"], .social-counts-reactions__count, .likes-count').replace(/[^\d,KkMm]/g, '');
      const comments  = q('[aria-label*="comment"], .social-counts-comments').replace(/[^\d,KkMm]/g, '');
      const timestamp = (card.querySelector('time')?.getAttribute('datetime') ?? q('.update-components-actor__sub-description').split('·').pop() ?? '').trim();
      const url       = a('a[href*="/feed/update/"], a[href*="activity:"]', 'href');
      const authorUrl = a('a[href*="/in/"], a[href*="/company/"]', 'href');

      if (author || text) out.push({ author, headline, text, likes, comments, timestamp, url, authorUrl });
    });
    return out;
  }).catch(() => []);

  while (results.length < target && scrolls < Math.ceil(target / 5) + 4) {
    const posts = await extract();
    let added = 0;
    for (const p of posts) {
      const key = p.url || p.text.slice(0, 80);
      if (key && !seen.has(key)) {
        seen.add(key); results.push(p); added++;
        if (results.length >= target) break;
      }
    }
    if (added > 0) console.log(`  ↓  Scroll ${String(scrolls+1).padStart(2,'0')} — +${added} new → ${results.length} total`);
    if (results.length >= target) break;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(2200);
    scrolls++;
    if (scrolls > 4 && results.length === 0) { console.log('  ⚠  No posts found. Ensure you are logged into LinkedIn.'); break; }
  }

  results.slice(0, 5).forEach((p, i) =>
    console.log(`  ${String(i+1).padStart(3,' ')}  ${p.author.slice(0,20).padEnd(20)}  ${p.text.replace(/\n/g,' ').slice(0,45) || '[no text]'}`)
  );
  console.log(`  ✓ LinkedIn feed "${keyword}" — ${results.length} posts in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return results;
}
