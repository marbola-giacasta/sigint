/**
 * src/output/reddit-excel.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original reddit-excel.mjs.
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
import ExcelJS from 'exceljs';
import { safeFilename } from '../utils/fs.js';
import { addRedditDashboard } from './dashboard.js';

const POST_COLS = [
  { header: 'Post ID',       key: 'postId',      width: 12  },
  { header: 'Title',         key: 'title',        width: 80  },
  { header: 'Author',        key: 'author',       width: 25  },
  { header: 'Subreddit',     key: 'subreddit',    width: 25  },
  { header: 'Score',         key: 'score',        width: 12  },
  { header: 'Upvote Ratio',  key: 'upvoteRatio',  width: 14  },
  { header: 'Num Comments',  key: 'numComments',  width: 14  },
  { header: 'Flair',         key: 'flair',        width: 25  },
  { header: 'Post URL',      key: 'postUrl',      width: 70  },
  { header: 'Permalink',     key: 'permalink',    width: 70  },
  { header: 'Is Video',      key: 'isVideo',      width: 10  },
  { header: 'Is Text Post',  key: 'isSelf',       width: 12  },
  { header: 'Text Preview',  key: 'selfText',     width: 100 },
  { header: 'Domain',        key: 'domain',       width: 30  },
  { header: 'Created UTC',   key: 'createdUtc',   width: 25  },
];

const SUB_COLS = [
  { header: 'Name',          key: 'name',         width: 30  },
  { header: 'Title',         key: 'title',        width: 60  },
  { header: 'URL',           key: 'url',          width: 60  },
  { header: 'Subscribers',   key: 'subscribers',  width: 15  },
  { header: 'Active Users',  key: 'activeUsers',  width: 14  },
  { header: 'Description',   key: 'description',  width: 100 },
  { header: 'Type',          key: 'type',         width: 15  },
  { header: 'NSFW',          key: 'nsfw',         width: 8   },
  { header: 'Created',       key: 'created',      width: 25  },
];

const COMMENT_COLS = [
  { header: 'Comment ID',    key: 'commentId',    width: 12  },
  { header: 'Post Title',    key: 'postTitle',    width: 60  },
  { header: 'Post URL',      key: 'postUrl',      width: 70  },
  { header: 'Author',        key: 'author',       width: 25  },
  { header: 'Subreddit',     key: 'subreddit',    width: 25  },
  { header: 'Body',          key: 'body',         width: 140 },
  { header: 'Score',         key: 'score',        width: 10  },
  { header: 'Depth',         key: 'depth',        width: 8   },
  { header: 'Is Top Level',  key: 'isTopLevel',   width: 12  },
  { header: 'Created UTC',   key: 'createdUtc',   width: 25  },
  { header: 'Permalink',     key: 'permalink',    width: 70  },
];

const SUB_META_COLS = [
  { header: 'Name',          key: 'name',         width: 30 },
  { header: 'Title',         key: 'title',        width: 60 },
  { header: 'Subscribers',   key: 'subscribers',  width: 15 },
  { header: 'Active Users',  key: 'activeUsers',  width: 14 },
  { header: 'URL',           key: 'url',          width: 60 },
];

function ensure(wb, name, cols) {
  let s = wb.getWorksheet(name);
  if (!s) { s = wb.addWorksheet(name); s.columns = cols; }
  return s;
}

// ── Post Search ───────────────────────────────────────────────────────────────

export function appendPostSearchResults(wb, rows) {
  const s = ensure(wb, 'Post Search Results', POST_COLS);
  for (const r of rows) s.addRow(r);
}

export async function savePostSearchWorkbook(wb, suffix = '') {
  addRedditDashboard(wb, 'post-search');
  const fn = `reddit_posts_${safeFilename(suffix)||Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}

// ── Subreddit Search ──────────────────────────────────────────────────────────

export function appendSubredditSearchResults(wb, rows) {
  const s = ensure(wb, 'Subreddit Results', SUB_COLS);
  for (const r of rows) s.addRow(r);
}

export async function saveSubredditSearchWorkbook(wb, suffix = '') {
  addRedditDashboard(wb, 'sub-search');
  const fn = `reddit_subreddits_${safeFilename(suffix)||Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}

// ── Subreddit Posts ───────────────────────────────────────────────────────────

export function appendSubredditPosts(wb, meta, posts) {
  const metaSheet = ensure(wb, 'Subreddit Info', SUB_META_COLS);
  if (meta?.name) metaSheet.addRow(meta);
  const s = ensure(wb, 'Posts', POST_COLS);
  for (const r of posts) s.addRow(r);
  if (posts.length) s.addRow({});
}

export async function saveSubredditWorkbook(wb, suffix = '') {
  addRedditDashboard(wb, 'subreddit');
  const fn = `reddit_subreddit_${safeFilename(suffix)||Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}

// ── Post Comments ─────────────────────────────────────────────────────────────

export function appendPostComments(wb, post, comments) {
  // Post summary sheet (one row per post)
  const postSheet = ensure(wb, 'Posts Info', POST_COLS);
  if (post) postSheet.addRow(post);

  const s = ensure(wb, 'Comments', COMMENT_COLS);
  for (const c of comments) s.addRow(c);
  if (comments.length) s.addRow({});
}

export async function saveCommentsWorkbook(wb, suffix = '') {
  addRedditDashboard(wb, 'post-comments');
  const fn = `reddit_comments_${safeFilename(suffix)||Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}
