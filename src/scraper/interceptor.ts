/**
 * src/scraper/interceptor.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Network response interceptor — the core mechanism behind all scrapers.
 *
 * HOW SCRAPING WORKS IN THIS PROJECT:
 * Modern websites (YouTube, Instagram, Reddit) are "Single Page Apps" (SPAs).
 * They load once, then fetch data in the background via JavaScript (API calls).
 * If we just read the HTML, we get an empty shell.
 * If we intercept those API calls, we get the real data.
 *
 * HOW page.on('response') WORKS:
 * Puppeteer lets us "listen" to every network response the browser receives.
 * For every response, our handler checks: "Is this URL one I care about?"
 * If yes, parse the JSON and extract the data we want.
 *
 * IMPORTANT: Attach the interceptor BEFORE navigating to the page.
 * The initial page load fires API calls immediately — if you attach after
 * goto(), you'll miss the first batch of data.
 *
 * TYPESCRIPT GENERICS:
 * <T> is a placeholder type that gets filled in when you call the function.
 * createResponseCollector<VideoResult[]>(page, matchFn, transformFn)
 * means T = VideoResult[], so collector.results is VideoResult[][].
 */
import type { Page, HTTPResponse } from 'puppeteer-core';

/**
 * The object returned by createResponseCollector.
 * 'results' accumulates data. 'stop' removes the listener when done.
 *
 * TYPESCRIPT: <T> means "an array of whatever T is"
 */
export interface ResponseCollector<T> {
  results: T[];
  stop: () => void; // () => void means "function that takes nothing and returns nothing"
}

/**
 * Attaches a network response interceptor to a Puppeteer page.
 *
 * @param page        - The browser tab to intercept
 * @param matchFn     - Returns true for URLs we want to capture
 *                      e.g. url => url.includes('youtubei/v1/search')
 * @param transformFn - Extracts data from the JSON response body.
 *                      Return null to skip a response.
 * @returns           ResponseCollector — use .results to read data, .stop() when done
 *
 * EXAMPLE (YouTube video search):
 *   const collector = createResponseCollector(
 *     page,
 *     url => url.includes('youtubei/v1/search'),
 *     json => extractVideosFromContinuation(json),
 *   );
 *   await page.goto(searchUrl, ...);  // this fires API calls
 *   await scrollPage();               // scroll fires more API calls
 *   collector.stop();                 // done, remove listener
 *   console.log(collector.results);  // all captured video batches
 */
export function createResponseCollector<T>(
  page:        Page,
  matchFn:     (url: string) => boolean,
  transformFn: (json: unknown) => T | null,
): ResponseCollector<T> {
  const results: T[] = [];

  // Handler is called for EVERY network response the browser receives
  const handler = async (response: HTTPResponse): Promise<void> => {
    if (!matchFn(response.url())) return; // skip URLs we don't care about
    try {
      const json = await response.json(); // parse response body as JSON
      const value = transformFn(json);    // extract our data
      if (value !== null && value !== undefined) results.push(value);
    } catch {
      // response.json() throws for non-JSON responses (images, CSS, etc.) — ignore
    }
  };

  page.on('response', handler); // register listener

  return {
    results,
    // off() removes the listener — always call this to prevent memory leaks
    stop: () => page.off('response', handler),
  };
}
