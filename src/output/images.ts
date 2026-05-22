/**
 * src/output/images.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original images.mjs.
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
 * src/output/images.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Media download helpers.
 *
 * Folder structure per profile:
 *
 *   instagram_images/
 *   └── <username>_<timestamp>/
 *       ├── posts/
 *       │   ├── username_post_0_<ts>.jpg
 *       │   └── username_post_1_<ts>.jpg
 *       └── stories/
 *           ├── username_story_0_<ts>.jpg    ← photo story
 *           └── username_story_1_<ts>.mp4    ← video clip / reel
 */

import fs   from 'fs';
import path from 'path';

import { ensureDir } from '../utils/fs.js';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

/** Derives extension from CDN URL, stripping query-string parameters. */
export function extFromUrl(url) {
  if (!url) return '.jpg';
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext || '.jpg';
  } catch { return '.jpg'; }
}

export function isVideoUrl(url) {
  return VIDEO_EXTS.has(extFromUrl(url));
}

/**
 * Creates:
 *   baseDir/<username>_<ts>/posts/
 *   baseDir/<username>_<ts>/stories/
 *
 * @returns {{ profileFolder, postsFolder, storiesFolder }}
 */
export function createProfileFolders(baseDir, profileName) {
  const safe           = profileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 100);
  const profileFolder  = path.join(baseDir, `${safe}_${Date.now()}`);
  const postsFolder    = path.join(profileFolder, 'posts');
  const storiesFolder  = path.join(profileFolder, 'stories');
  ensureDir(postsFolder);
  ensureDir(storiesFolder);
  return { profileFolder, postsFolder, storiesFolder };
}

/**
 * Downloads any media file (image or video) via a new browser tab so
 * Instagram CDN auth cookies are automatically forwarded.
 *
 * @returns {Promise<boolean>}
 */
export async function downloadMediaFile(page, url, destPath) {
  if (!url) return false;
  let tab;
  try {
    tab = await page.browser().newPage();
    await tab.setViewport({ width: 800, height: 600 });
    const response = await tab.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
    if (!response?.ok()) { await tab.close(); return false; }
    fs.writeFileSync(destPath, await response.buffer());
    await tab.close();
    return true;
  } catch {
    try { await tab?.close(); } catch {}
    return false;
  }
}
