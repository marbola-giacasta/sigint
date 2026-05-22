/**
 * src/output/excel.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original excel.mjs.
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
 * src/output/excel.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Instagram Excel workbook builder.
 *
 * Change from v3: every media row now has two path columns:
 *   "Local File Path" — absolute path to the downloaded file on disk
 *   "CDN URL"         — the original Instagram CDN URL, openable in a browser
 *
 * Stories sheet also has a "Media Type" column (photo | video).
 */

import path    from 'path';
import ExcelJS from 'exceljs';

import { safeFilename }                                       from '../utils/fs.js';
import { createProfileFolders, downloadMediaFile,
         extFromUrl, isVideoUrl }                             from './images.js';
import { addInstagramDashboard }                              from './dashboard.js';

// ── Column definitions ────────────────────────────────────────────────────────

const SUMMARY_COLUMNS = [
  { header: 'Profile',  key: 'profile', width: 30 },
  { header: 'Field',    key: 'field',   width: 22 },
  { header: 'Value',    key: 'value',   width: 80 },
];

const POSTS_COLUMNS = [
  { header: 'Profile',                   key: 'profile',        width: 30  },
  { header: 'Index',                     key: 'index',          width: 8   },
  { header: 'Local File Path',           key: 'localPath',      width: 90  },
  { header: 'CDN URL',                   key: 'cdnUrl',         width: 120 },
  { header: 'Timestamp',                 key: 'timestamp',      width: 30  },
  { header: 'Description',               key: 'description',    width: 100 },
  { header: 'Likes',                     key: 'likes',          width: 12  },
  { header: 'Comments Count',            key: 'commentsCount',  width: 16  },
  { header: 'Comments (username: text)', key: 'comments',       width: 120 },
];

const STORIES_COLUMNS = [
  { header: 'Profile',                   key: 'profile',        width: 30  },
  { header: 'Index',                     key: 'index',          width: 8   },
  { header: 'Media Type',               key: 'mediaType',      width: 12  },
  { header: 'Local File Path',           key: 'localPath',      width: 90  },
  { header: 'CDN URL',                   key: 'cdnUrl',         width: 120 },
  { header: 'Timestamp',                 key: 'timestamp',      width: 30  },
  { header: 'Description',               key: 'description',    width: 100 },
  { header: 'Likes',                     key: 'likes',          width: 12  },
  { header: 'Comments Count',            key: 'commentsCount',  width: 16  },
  { header: 'Comments (username: text)', key: 'comments',       width: 120 },
];

// ── Sheet init ────────────────────────────────────────────────────────────────

function ensureSheetsExist(workbook) {
  let summarySheet = workbook.getWorksheet('Summary');
  if (!summarySheet) { summarySheet = workbook.addWorksheet('Summary'); summarySheet.columns = SUMMARY_COLUMNS; }

  let postsSheet = workbook.getWorksheet('Last Posts');
  if (!postsSheet) { postsSheet = workbook.addWorksheet('Last Posts'); postsSheet.columns = POSTS_COLUMNS; }

  let storiesSheet = workbook.getWorksheet('Last Stories');
  if (!storiesSheet) { storiesSheet = workbook.addWorksheet('Last Stories'); storiesSheet.columns = STORIES_COLUMNS; }

  return { summarySheet, postsSheet, storiesSheet };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function joinComments(comments) {
  return (comments ?? []).map(c => `${c.username} (${c.date}): ${c.text}`).join('\n');
}

async function writeMediaRows(items, sheet, profileName, kind, folder, page) {
  for (let i = 0; i < items.length; i++) {
    const item     = items[i];
    const idx      = typeof item.index === 'number' ? item.index : i;
    const ext      = extFromUrl(item.imageUrl);
    const filename = `${safeFilename(profileName)}_${kind}_${idx}_${Date.now()}${ext}`;
    const filePath  = path.join(folder, filename);

    let downloaded = false;
    if (item.imageUrl) {
      try { downloaded = await downloadMediaFile(page, item.imageUrl, filePath); } catch {}
    }

    const row = {
      profile:       profileName,
      index:         idx,
      localPath:     downloaded ? filePath : '',   // empty if download failed
      cdnUrl:        item.imageUrl ?? '',           // always preserved
      timestamp:     item.timestamp ?? new Date().toISOString(),
      description:   item.description    ?? '',
      likes:         item.likes          ?? '',
      commentsCount: item.commentsCount  ?? '',
      comments:      joinComments(item.comments),
    };

    if (kind === 'story') {
      (row as any).mediaType = (item.isVideo || isVideoUrl(item.imageUrl)) ? 'video' : 'photo';
    }

    sheet.addRow(row);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function exportProfileToWorkbookAppend(
  workbook, profileName, summary, posts, stories, imagesBaseDir, page,
) {
  const { summarySheet, postsSheet, storiesSheet } = ensureSheetsExist(workbook);

  if (summarySheet.rowCount > 1) summarySheet.addRow({ profile: '' });
  if (postsSheet.rowCount   > 1) postsSheet.addRow({ profile: '' });
  if (storiesSheet.rowCount > 1) storiesSheet.addRow({ profile: '' });

  for (const [field, value] of [
    ['Username',    summary?.username    ?? ''],
    ['Full Name',   summary?.fullName    ?? ''],
    ['Description', summary?.description ?? ''],
    ['Posts',       summary?.posts       ?? ''],
    ['Followers',   summary?.followers   ?? ''],
    ['Following',   summary?.following   ?? ''],
  ]) summarySheet.addRow({ profile: profileName, field, value });

  const { postsFolder, storiesFolder } = createProfileFolders(imagesBaseDir, profileName);
  const safePosts   = Array.isArray(posts)   ? posts   : [];
  const safeStories = Array.isArray(stories) ? stories : [];

  console.log(`  Exporting: ${safePosts.length} posts → ${postsFolder}`);
  if (safeStories.length) console.log(`           : ${safeStories.length} stories → ${storiesFolder}`);

  await writeMediaRows(safePosts,   postsSheet,   profileName, 'post',  postsFolder,   page);
  await writeMediaRows(safeStories, storiesSheet, profileName, 'story', storiesFolder, page);
}

export async function exportSingleProfileWorkbook(profileName, summary, posts, stories, imagesBaseDir, page) {
  const workbook = new ExcelJS.Workbook();
  await exportProfileToWorkbookAppend(workbook, profileName, summary, posts, stories, imagesBaseDir, page);
  addInstagramDashboard(workbook);
  const fileName = `ig_scraper_${safeFilename(profileName)}_${Date.now()}.xlsx`;
  await workbook.xlsx.writeFile(fileName);
  console.log(`\n  ✔ Saved → ${fileName}`);
  return fileName;
}
