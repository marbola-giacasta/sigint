/**
 * src/output/x-excel.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original x-excel.mjs.
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

const TWEET_COLS = [
  { header:'Tweet ID',        key:'tweetId',        width:20  },
  { header:'Text',            key:'text',            width:140 },
  { header:'Author',          key:'author',          width:25  },
  { header:'Author Name',     key:'authorName',      width:30  },
  { header:'Verified',        key:'authorVerified',  width:10  },
  { header:'Author Followers',key:'authorFollowers', width:16  },
  { header:'Likes',           key:'likes',           width:12  },
  { header:'Retweets',        key:'retweets',        width:12  },
  { header:'Replies',         key:'replies',         width:12  },
  { header:'Quotes',          key:'quotes',          width:12  },
  { header:'Views',           key:'views',           width:14  },
  { header:'Timestamp',       key:'timestamp',       width:25  },
  { header:'Language',        key:'language',        width:10  },
  { header:'Is Retweet',      key:'isRetweet',       width:12  },
  { header:'Is Reply',        key:'isReply',         width:12  },
  { header:'Tweet URL',       key:'tweetUrl',        width:70  },
  { header:'Query / Context', key:'contextQuery',    width:30  },
];

function ensure(wb, name, cols) {
  let s = wb.getWorksheet(name);
  if (!s) { s = wb.addWorksheet(name); s.columns = cols; }
  return s;
}

export function appendXTweets(wb, rows, sheetName = 'Tweets') {
  const s = ensure(wb, sheetName, TWEET_COLS);
  for (const r of rows) s.addRow(r);
}

export function appendXProfileMeta(wb, meta) {
  ensure(wb, 'Profile Info', [
    { header:'Username', key:'username', width:25 },
    { header:'Title',    key:'title',    width:60 },
    { header:'Bio',      key:'description', width:120 },
  ]).addRow(meta);
}

export async function saveXWorkbook(wb, suffix = '') {
  // dynamic import to avoid circular dep
  try {
    const { addXDashboard } = await import('./dashboard.js');
    addXDashboard(wb);
  } catch {}
  const fn = `x_scrape_${safeFilename(suffix)||Date.now()}_${Date.now()}.xlsx`;
  await wb.xlsx.writeFile(fn);
  console.log(`\n  ✔ Saved → ${fn}`);
  return fn;
}
