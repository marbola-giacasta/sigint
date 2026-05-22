/**
 * src/utils/sleep.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Pauses the scraper for N milliseconds.
 *
 * WHY WE NEED SLEEP:
 * 1. Anti-bot: acting too fast gets you blocked by Instagram/YouTube/Reddit.
 * 2. Page loading: dynamic content loads asynchronously after page.goto().
 *
 * HOW IT WORKS:
 * setTimeout(fn, ms) calls fn after ms milliseconds — it's a browser/Node API.
 * new Promise(resolve => ...) creates a Promise (a "future value").
 * When setTimeout fires, resolve() is called, completing the Promise.
 * 'await sleep(2000)' pauses the current async function for 2 seconds.
 *
 * TYPESCRIPT: Promise<void> means the Promise resolves with no value.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, ms));
