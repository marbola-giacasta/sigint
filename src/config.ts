/**
 * src/config.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Single source of truth for every tunable constant in the scraper.
 *
 * WHY ONE CONFIG FILE?
 * If you hardcode numbers across 40 files and want to change a timeout,
 * you'd have to find and update all 40 places. Define it once here and
 * import it everywhere — change it here and ALL scrapers update at once.
 *
 * TYPESCRIPT: 'as const' makes every value a readonly literal type.
 * Without it: navTimeout has type 'number' (any number).
 * With it:    navTimeout has type '90000' (exactly 90000, readonly).
 * This prevents accidental mutation: CONFIG.navTimeout = 0 → compile error.
 */
export const CONFIG = {

  /** How long (ms) to wait for a page to load before giving up */
  navTimeout: 90_000,

  /** How many times to retry a failed navigation */
  gotoRetryCount: 3,

  /** How long (ms) to wait between retry attempts */
  gotoRetryDelayMs: 5_000,

  instagram: {
    /** Instagram base URL */
    baseUrl: 'https://www.instagram.com',

    /** Folder name where downloaded images are saved */
    imagesDirName: 'instagram_images',

    /** Max parallel browser tabs in batch mode */
    parallelTabs: 3,

    /** How long to wait for user to complete Instagram login (ms) */
    loginTimeoutMs: 180_000,

    /** Base delay between scroll events on the feed (ms) */
    scrollDelayBase: 1_400,

    /** Delay after loading each post's detail page (ms) */
    postDetailDelay: 1_800,

    /** Pause between batches of profiles (ms) */
    batchPauseMs: 6_000,

    storiesInitialWaitMs: 5_000,
    storiesScrollWaitMs: 2_000,
    storiesMaxScrollAttempts: 8,
    storiesApiPollMs: 500,
    storiesApiTimeoutMs: 20_000,
  },

  youtube: {
    /** YouTube base URL */
    baseUrl: 'https://www.youtube.com',
    outputDirName: 'youtube_output',

    /** Delay between scroll events on search/channel pages (ms) */
    searchScrollPauseMs: 1_800,

    /** Max scroll attempts on search pages */
    searchMaxScrolls: 15,

    commentScrollPauseMs: 2_000,
    commentMaxScrolls: 50,

    /** Pause between scraping multiple videos/keywords (ms) */
    batchPauseMs: 4_000,
  },

} as const; // ← makes all values readonly literal types

/**
 * The User-Agent string sent with every browser request.
 * Using a real Chrome UA makes websites treat the scraper like a real user.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
