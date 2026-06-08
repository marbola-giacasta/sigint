/**
 * src/scraper/linkedin/job-search.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Scrapes LinkedIn Jobs search results by keyword (job title or description).
 *
 * STRATEGY:
 *   Navigate to linkedin.com/jobs/search/?keywords={keyword}
 *   and extract job cards. Each card contains: title, company, location,
 *   salary (when shown), job type, posted date, and the apply URL.
 *
 * REQUIREMENTS:
 *   Browser should be logged into LinkedIn for full results. Guest access
 *   is possible for a limited number of results before hitting the login wall.
 */

import { sleep }                   from '../../utils/sleep.js';
import { safeGoto, dismissPopups } from '../../browser/page.js';

const LI_BASE = 'https://www.linkedin.com';

/** A single LinkedIn job listing */
export interface LinkedInJob {
  title:     string;  // Job title, e.g. "Senior Software Engineer"
  company:   string;  // Company name
  location:  string;  // City, Country or "Remote"
  jobType:   string;  // "Full-time", "Part-time", "Contract", etc.
  salary:    string;  // Salary range when shown, or ""
  posted:    string;  // Relative time: "2 days ago", "1 week ago"
  url:       string;  // Direct link to the job posting
  easyApply: boolean; // True if LinkedIn Easy Apply is available
}

/**
 * Search LinkedIn Jobs for listings matching keyword.
 * @param page        Puppeteer page (login improves result quality)
 * @param keyword     Job title or skill, e.g. "TypeScript developer" or "product manager"
 * @param location    Optional location filter, e.g. "Switzerland" or "Remote"
 * @param limitConfig { mode:'all'|'count', count?:number }
 */
export async function scrapeLinkedInJobs(
  page: any,
  keyword: string,
  location: string = '',
  limitConfig: { mode: string; count?: number | null } = { mode: 'count', count: 50 },
): Promise<LinkedInJob[]> {

  const target = limitConfig.mode === 'all' ? 200 : (limitConfig.count ?? 50);

  console.log(`  ┌─ LinkedIn Job Search ───────────────────────────`);
  console.log(`  │  Keyword  : "${keyword}"`);
  if (location) console.log(`  │  Location : "${location}"`);
  console.log(`  │  Target   : ${target} listings`);
  console.log(`  └───────────────────────────────────────────────────`);

  const t0 = Date.now();

  // Build the search URL — LinkedIn's job search supports keyword + location params
  const params = new URLSearchParams({ keywords: keyword });
  if (location) params.set('location', location);
  params.set('sortBy', 'DD'); // DD = date descending (most recent first)

  await safeGoto(page, `${LI_BASE}/jobs/search/?${params}`);
  await sleep(2500);
  await dismissPopups(page);
  await sleep(1000);

  // Check for login wall
  if (page.url().includes('/login') || page.url().includes('/uas/login')) {
    console.log('  ⚠  LinkedIn login required for job search.');
    return [];
  }

  const seen    = new Set<string>();
  const results: LinkedInJob[] = [];
  let   scrolls = 0;
  const maxScrolls = Math.ceil(target / 10) + 5;

  /**
   * Extracts job cards from the current DOM state.
   * LinkedIn renders jobs as <li> elements inside .jobs-search__results-list.
   * Each li contains a job card with title, company, location, etc.
   */
  const extract = (): Promise<LinkedInJob[]> => page.evaluate((): any[] => {
    const jobs: any[] = [];

    // Job cards appear in different containers depending on whether user is logged in
    const cards = document.querySelectorAll(
      '.jobs-search__results-list > li, ' +
      '.scaffold-layout__list-item, ' +
      '.job-card-container'
    );

    cards.forEach((card: any) => {
      const q  = (sel: string) => card.querySelector(sel)?.textContent?.trim() ?? '';
      const qa = (sel: string, attr: string) => card.querySelector(sel)?.getAttribute(attr) ?? '';

      // Title is usually in an <a> tag with the job link
      const titleEl = card.querySelector(
        '.job-card-list__title, .job-card-container__link, ' +
        'a[href*="/jobs/view/"] strong, .jobs-unified-top-card__job-title a'
      );
      const title = titleEl?.textContent?.trim() ?? '';
      const url   = titleEl?.getAttribute('href')
        ?? qa('a[href*="/jobs/view/"]', 'href')
        ?? '';

      const company  = q('.job-card-container__primary-description, .job-card-container__company-name, .artdeco-entity-lockup__subtitle');
      const location = q('.job-card-container__metadata-item, .job-card-container__metadata-wrapper, .artdeco-entity-lockup__caption');
      const salary   = q('.job-card-container__salary-info, [class*="salary"]');
      const jobType  = q('.job-card-container__metadata-item--workplace-type, [class*="job-type"]');
      const posted   = q('.job-card-container__listdate, time, .job-card-list__footer-wrapper');

      // Easy Apply badge indicates LinkedIn's one-click application
      const easyApply = !!card.querySelector('[data-easy-apply-button], .jobs-apply-button--top-card, .easy-apply-badge');

      if (title && url) {
        jobs.push({ title, company, location, salary, jobType, posted, url, easyApply });
      }
    });

    return jobs;
  }).catch(() => []);

  // Scroll to load more job cards
  while (results.length < target && scrolls < maxScrolls) {
    const jobs = await extract();
    let added = 0;

    for (const j of jobs) {
      // Use URL as dedup key (normalized to remove tracking params)
      const key = j.url.split('?')[0];
      if (key && !seen.has(key)) {
        seen.add(key); results.push(j); added++;
        if (results.length >= target) break;
      }
    }

    if (added > 0)
      console.log(`  ↓  Scroll ${String(scrolls+1).padStart(2,'0')} — +${added} new → ${results.length} total`);

    if (results.length >= target) break;

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(2000);
    scrolls++;

    if (scrolls > 4 && results.length === 0) {
      console.log('  ⚠  No jobs found. Ensure you are logged into LinkedIn.');
      break;
    }
  }

  // Log a sample of results
  results.slice(0, 5).forEach((j, i) =>
    console.log(
      `  ${String(i+1).padStart(3,' ')}  ${j.title.slice(0,28).padEnd(28)}  ` +
      `${j.company.slice(0,20).padEnd(20)}  ${j.location.slice(0,20)}`
    )
  );

  console.log(`  ✓ LinkedIn jobs "${keyword}" — ${results.length} listings in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return results;
}
