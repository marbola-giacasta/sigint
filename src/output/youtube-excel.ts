/**
 * src/output/youtube-excel.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original youtube-excel.mjs.
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
import {
  addYouTubeSearchDashboard,
  addYouTubeCommentsDashboard,
  addChannelSearchDashboard,
  addChannelVideosDashboard,
} from './dashboard.js';

// ── Column definitions ────────────────────────────────────────────────────────

const SEARCH_COLUMNS = [
  { header: 'Keyword',             key: 'keyword',            width: 30  },
  { header: 'Position',            key: 'position',           width: 10  },
  { header: 'Title',               key: 'title',              width: 80  },
  { header: 'Video URL',           key: 'url',                width: 60  },
  { header: 'Channel',             key: 'channelName',        width: 40  },
  { header: 'View Count',          key: 'viewCount',          width: 20  },
  { header: 'Duration',            key: 'duration',           width: 12  },
  { header: 'Upload Date',         key: 'uploadDate',         width: 20  },
  { header: 'Description Snippet', key: 'descriptionSnippet', width: 120 },
  { header: 'Thumbnail URL',       key: 'thumbnailUrl',       width: 100 },
];

const VIDEO_INFO_COLUMNS = [
  { header: 'Video URL',     key: 'videoUrl',     width: 60  },
  { header: 'Title',         key: 'title',        width: 80  },
  { header: 'Channel',       key: 'channelName',  width: 40  },
  { header: 'View Count',    key: 'viewCount',    width: 20  },
  { header: 'Like Count',    key: 'likeCount',    width: 20  },
  { header: 'Upload Date',   key: 'uploadDate',   width: 20  },
  { header: 'Comment Count', key: 'commentCount', width: 16  },
  { header: 'Description',   key: 'description',  width: 120 },
];

const COMMENTS_COLUMNS = [
  { header: 'Video URL',     key: 'videoUrl',     width: 60  },
  { header: 'Video Title',   key: 'videoTitle',   width: 60  },
  { header: 'Comment #',     key: 'commentIndex', width: 10  },
  { header: 'Author',        key: 'author',       width: 30  },
  { header: 'Comment Text',  key: 'text',         width: 140 },
  { header: 'Likes',         key: 'likes',        width: 12  },
  { header: 'Date',          key: 'date',         width: 20  },
  { header: 'Replies',       key: 'replyCount',   width: 10  },
  { header: 'Is Reply',      key: 'isReply',      width: 10  },
  { header: 'Parent Author', key: 'parentAuthor', width: 30  },
];

const CHANNEL_SEARCH_COLUMNS = [
  { header: 'Keyword',      key: 'keyword',      width: 30  },
  { header: 'Position',     key: 'position',     width: 10  },
  { header: 'Channel Name', key: 'channelName',  width: 50  },
  { header: 'Channel URL',  key: 'channelUrl',   width: 70  },
  { header: 'Subscribers',  key: 'subscribers',  width: 20  },
  { header: 'Video Count',  key: 'videoCount',   width: 16  },
  { header: 'Description',  key: 'description',  width: 120 },
  { header: 'Avatar URL',   key: 'avatarUrl',    width: 100 },
  { header: 'Verified',     key: 'verified',     width: 10  },
];

const CHANNEL_META_COLUMNS = [
  { header: 'Channel Name', key: 'channelName', width: 50 },
  { header: 'Channel URL',  key: 'channelUrl',  width: 70 },
  { header: 'Subscribers',  key: 'subscribers', width: 20 },
];

const CHANNEL_VIDEOS_COLUMNS = [
  { header: 'Channel Name',        key: 'channelName',        width: 40  },
  { header: 'Channel URL',         key: 'channelUrl',         width: 70  },
  { header: 'Position',            key: 'position',           width: 10  },
  { header: 'Title',               key: 'title',              width: 80  },
  { header: 'Video URL',           key: 'videoUrl',           width: 60  },
  { header: 'View Count',          key: 'viewCount',          width: 20  },
  { header: 'Duration',            key: 'duration',           width: 12  },
  { header: 'Upload Date',         key: 'uploadDate',         width: 20  },
  { header: 'Description Snippet', key: 'descriptionSnippet', width: 120 },
  { header: 'Thumbnail URL',       key: 'thumbnailUrl',       width: 100 },
];

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function ensureSheet(wb, name, columns) {
  let s = wb.getWorksheet(name);
  if (!s) { s = wb.addWorksheet(name); s.columns = columns; }
  return s;
}

// ── Search ────────────────────────────────────────────────────────────────────

export function appendSearchResults(wb, rows) {
  const s = ensureSheet(wb, 'Search Results', SEARCH_COLUMNS);
  for (const r of rows) s.addRow(r);
}

export async function saveSearchWorkbook(wb, suffix = '') {
  addYouTubeSearchDashboard(wb);
  const fn = `yt_search_${safeFilename(suffix) || Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}

// ── Comments ──────────────────────────────────────────────────────────────────

export function appendVideoComments(wb, meta, comments) {
  const info = ensureSheet(wb, 'Video Info', VIDEO_INFO_COLUMNS);
  info.addRow({
    videoUrl: meta.videoUrl ?? '', title: (meta as any).title ?? '',
    channelName: meta.channelName ?? '', viewCount: meta.viewCount ?? '',
    likeCount: meta.likeCount ?? '', uploadDate: meta.uploadDate ?? '',
    commentCount: meta.commentCount ?? '', description: meta.description ?? '',
  });
  const cs = ensureSheet(wb, 'Comments', COMMENTS_COLUMNS);
  for (const c of comments) cs.addRow(c);
  if (comments.length) cs.addRow({});
}

export async function saveCommentsWorkbook(wb, suffix = '') {
  addYouTubeCommentsDashboard(wb);
  const fn = `yt_comments_${safeFilename(suffix) || Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}

// ── Channel Search ────────────────────────────────────────────────────────────

export function appendChannelSearchResults(wb, rows) {
  const s = ensureSheet(wb, 'Channel Search', CHANNEL_SEARCH_COLUMNS);
  for (const r of rows) s.addRow(r);
}

export async function saveChannelSearchWorkbook(wb, suffix = '') {
  addChannelSearchDashboard(wb);
  const fn = `yt_channels_${safeFilename(suffix) || Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}

// ── Channel Videos ────────────────────────────────────────────────────────────

export function appendChannelVideos(wb, meta, videos) {
  const info = ensureSheet(wb, 'Channel Info', CHANNEL_META_COLUMNS);
  info.addRow({ channelName: meta.channelName ?? '', channelUrl: meta.channelUrl ?? '', subscribers: (meta as any).subscribers ?? '' });
  const vs = ensureSheet(wb, 'Channel Videos', CHANNEL_VIDEOS_COLUMNS);
  for (const v of videos) vs.addRow(v);
  if (videos.length) vs.addRow({});
}

export async function saveChannelVideosWorkbook(wb, suffix = '') {
  addChannelVideosDashboard(wb);
  const fn = `yt_channel_videos_${safeFilename(suffix) || Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}
