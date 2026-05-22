/**
 * src/output/dashboard.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original dashboard.mjs.
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
 * src/output/dashboard.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Professional dashboard + preset sheets for every scraper output type.
 *
 * Exports one function per workbook type — call it right before saving:
 *   addYouTubeCommentsDashboard(wb)
 *   addYouTubeSearchDashboard(wb)
 *   addChannelSearchDashboard(wb)
 *   addChannelVideosDashboard(wb)
 *   addInstagramDashboard(wb)
 *
 * Each call adds:
 *   📊 Dashboard        — KPI cards, ranked tables, distribution, insights
 *   📋 Top Performers   — clean sorted view of the best-performing items
 *   📋 Distribution     — bucketed frequency analysis
 */

// ═══════════════════════════════════════════════════════════════════════════════
//  THEME
// ═══════════════════════════════════════════════════════════════════════════════

const C = {
  NAVY:       'FF1A2F5A',
  BLUE:       'FF2563AE',
  BLUE2:      'FF3A7DD6',
  SKY:        'FF4BACC6',
  TEAL:       'FF17819C',
  GREEN:      'FF4CAF50',
  DKGREEN:    'FF2E7D32',
  AMBER:      'FFFFC107',
  ORANGE:     'FFED7D31',
  RED:        'FFE53935',
  PURPLE:     'FF6A1B9A',
  WHITE:      'FFFFFFFF',
  OFF_WHITE:  'FFF0F4FA',
  LT_GRAY:    'FFD0D9E8',
  MID_GRAY:   'FF7B8CAA',
  DK_GRAY:    'FF363D4A',
  ROW_A:      'FFF0F4FA',
  ROW_B:      'FFFFFFFF',
  GOLD:       'FFFFD700',
};

// ═══════════════════════════════════════════════════════════════════════════════
//  LOW-LEVEL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const clr   = argb => ({ argb });

const border = (style = 'thin', argb = C.LT_GRAY) => ({
  top:    { style, color: clr(argb) },
  bottom: { style, color: clr(argb) },
  left:   { style, color: clr(argb) },
  right:  { style, color: clr(argb) },
});

const bottomBorder = (argb = C.BLUE) => ({
  bottom: { style: 'medium', color: clr(argb) },
});

function sc(ws, row, col) { return ws.getCell(row, col); }

function style(cell: any, { bg, bold, size = 10, color = C.DK_GRAY, italic, font,
                       halign = 'center', valign = 'middle', wrap, border: brd, numFmt }: any = {}) {
  if (bg)   cell.fill = solid(bg);
  if (brd)  cell.border = brd;
  if (numFmt) cell.numFmt = numFmt;
  cell.font = {
    name: font || 'Calibri',
    size, bold: !!bold, italic: !!italic,
    color: clr(color),
  };
  cell.alignment = { horizontal: halign, vertical: valign, wrapText: !!wrap };
}

function write(ws, row, col, value, opts = {}) {
  const cell = sc(ws, row, col);
  cell.value  = value;
  style(cell, opts);
  return cell;
}

function merge(ws, r1, c1, r2, c2, value, opts = {}) {
  try { ws.mergeCells(r1, c1, r2, c2); } catch {}
  return write(ws, r1, c1, value, opts);
}

function fillRow(ws, row, cols, bg) {
  for (let c = 1; c <= cols; c++) ws.getCell(row, c).fill = solid(bg);
}

function shade(hexBg, delta) {
  try {
    const h = hexBg.slice(2);
    return 'FF' + [h.slice(0,2), h.slice(2,4), h.slice(4,6)]
      .map(x => Math.max(0, Math.min(255, parseInt(x, 16) + delta)).toString(16).padStart(2,'0'))
      .join('');
  } catch { return hexBg; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATA READING
// ═══════════════════════════════════════════════════════════════════════════════

function readSheet(wb, name) {
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const hdrs = [];
  const rows = [];
  ws.eachRow((row, ri) => {
    if (ri === 1) { row.eachCell((c, ci) => { hdrs[ci] = String(c.value ?? ''); }); return; }
    const vals = row.values; // 1-indexed
    const allBlank = !vals || vals.slice(1).every(v => v === null || v === '' || v === undefined);
    if (allBlank) return;
    const obj = {};
    hdrs.forEach((h, ci) => { if (h) obj[h] = vals[ci] ?? null; });
    rows.push(obj);
  });
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NUMERIC HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function toNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/,/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (/[Bb]/i.test(s)) return Math.round(n * 1e9);
  if (/[Mm]/i.test(s)) return Math.round(n * 1e6);
  if (/[Kk]/i.test(s)) return Math.round(n * 1e3);
  return Math.round(n);
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function pct(a, b) { return b ? ((a / b) * 100).toFixed(1) + '%' : '—'; }

function freq(arr) {
  const m = new Map();
  arr.forEach(v => { if (v) m.set(v, (m.get(v) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONDITIONAL FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

function dataBar(ws, ref, color = C.BLUE) {
  try {
    ws.addConditionalFormatting({
      ref,
      rules: [{ type: 'dataBar', priority: 1,
                cfvo: [{ type: 'min' }, { type: 'max' }],
                color: clr(color) }],
    });
  } catch {}
}

function colorScale(ws, ref) {
  try {
    ws.addConditionalFormatting({
      ref,
      rules: [{ type: 'colorScale', priority: 1,
                cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }],
                color: [clr('FFF8696B'), clr('FFFFEB84'), clr('FF63BE7B')] }],
    });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STRUCTURAL BLOCKS
// ═══════════════════════════════════════════════════════════════════════════════

const COLS = 14; // dashboard width in columns

/** Big navy+blue title banner. Returns next row. */
function hdr(ws, title, subtitle, ts) {
  ws.getRow(1).height = 6;  fillRow(ws, 1, COLS, C.NAVY);
  ws.getRow(2).height = 44; fillRow(ws, 2, COLS, C.NAVY);
  ws.getRow(3).height = 6;  fillRow(ws, 3, COLS, C.NAVY);
  merge(ws, 2, 1, 2, COLS, title,
    { bg: C.NAVY, bold: true, size: 24, color: C.WHITE, halign: 'center' });

  ws.getRow(4).height = 22;
  merge(ws, 4, 1, 4, COLS, subtitle,
    { bg: C.BLUE, size: 11, italic: true, color: C.OFF_WHITE, halign: 'center' });

  ws.getRow(5).height = 18;
  merge(ws, 5, 1, 5, 7, `  📅 Generated: ${ts}`,
    { bg: C.SKY, size: 9, color: C.WHITE, halign: 'left' });
  merge(ws, 5, 8, 5, COLS, 'Instagram & YouTube Scraper v4  ·  Puppeteer  ',
    { bg: C.SKY, size: 9, color: C.WHITE, halign: 'right' });

  ws.getRow(6).height = 8; fillRow(ws, 6, COLS, C.OFF_WHITE);
  return 7;
}

/** Section divider. Returns next row. */
function sec(ws, row, text, bg = C.BLUE) {
  ws.getRow(row).height = 24;
  merge(ws, row, 1, row, COLS, `  ${text}`,
    { bg, bold: true, size: 11, color: C.WHITE, halign: 'left' });
  return row + 1;
}

/** Spacer row. Returns next row. */
function gap(ws, row, h = 10) {
  ws.getRow(row).height = h;
  fillRow(ws, row, COLS, C.OFF_WHITE);
  return row + 1;
}

/** Navigation bar with hyperlinks. Returns next row. */
function nav(ws, row, links) {
  ws.getRow(row).height = 20;
  write(ws, row, 1, 'VIEWS:', { bg: C.DK_GRAY, bold: true, size: 8, color: C.LT_GRAY });
  let c = 2;
  for (const { label, sheet } of links) {
    const span = Math.max(2, Math.ceil(label.length * 0.55));
    ws.mergeCells(row, c, row, c + span - 1);
    const cell = ws.getCell(row, c);
    cell.value = { text: label, hyperlink: `#'${sheet}'!A1` };
    cell.fill  = solid(C.BLUE2);
    cell.font  = { name: 'Calibri', size: 9, bold: true, color: clr(C.WHITE), underline: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    // gap
    if (c + span <= COLS) ws.getCell(row, c + span).fill = solid(C.DK_GRAY);
    c += span + 1;
    if (c >= COLS) break;
  }
  for (let cc = c; cc <= COLS; cc++) ws.getCell(row, cc).fill = solid(C.DK_GRAY);
  return row + 2;
}

/** 4-up KPI card row. Returns next row. */
function kpiRow(ws, row, cards) {
  const widths = [3, 3, 3, 3]; // 3 cols each + 1 gap = 13
  let col = 1;

  cards.forEach((k, i) => {
    const w  = widths[i];
    const bg = k.color || [C.NAVY, C.BLUE, C.TEAL, C.PURPLE][i];
    const dk = shade(bg, -25);

    ws.getRow(row    ).height = 8;
    ws.getRow(row + 1).height = 38;
    ws.getRow(row + 2).height = 16;
    ws.getRow(row + 3).height = 14;
    ws.getRow(row + 4).height = 10;

    for (let c = col; c < col + w; c++) ws.getCell(row, c).fill = solid(bg);
    merge(ws, row + 1, col, row + 1, col + w - 1, k.value,
      { bg, bold: true, size: 26, color: C.WHITE, halign: 'center', valign: 'bottom' });
    merge(ws, row + 2, col, row + 2, col + w - 1, (k.label || '').toUpperCase(),
      { bg, size: 8, color: C.OFF_WHITE, halign: 'center', valign: 'top' });
    merge(ws, row + 3, col, row + 3, col + w - 1, k.sub || '',
      { bg: dk, size: 8, color: C.LT_GRAY, italic: true, halign: 'center' });
    for (let c = col; c < col + w; c++) ws.getCell(row + 4, c).fill = solid(dk);

    col += w;
    if (i < cards.length - 1) {
      for (let r = row; r <= row + 4; r++) ws.getCell(r, col).fill = solid(C.OFF_WHITE);
      col++;
    }
  });
  // fill the rest of the last row
  for (let c = col; c <= COLS; c++) {
    for (let r = row; r <= row + 4; r++) ws.getCell(r, c).fill = solid(C.OFF_WHITE);
  }
  return row + 6;
}

/** Ranked table. Returns next row. */
function table(ws, row, headers, rows, barCols = [], maxRows = 20) {
  ws.getRow(row).height = 20;
  headers.forEach((h, i) => {
    write(ws, row, i + 1, h,
      { bg: C.NAVY, bold: true, size: 9, color: C.WHITE, halign: 'center', border: border('thin', C.BLUE) });
  });
  for (let c = headers.length + 1; c <= COLS; c++) ws.getCell(row, c).fill = solid(C.NAVY);

  const limited = rows.slice(0, maxRows);
  limited.forEach((r, ri) => {
    const bg = ri % 2 === 0 ? C.ROW_A : C.ROW_B;
    ws.getRow(row + 1 + ri).height = 18;
    r.forEach((v, ci) => {
      write(ws, row + 1 + ri, ci + 1, v, {
        bg: ci === 0 ? C.BLUE : bg,
        bold: ci === 0, size: 10,
        color: ci === 0 ? C.WHITE : C.DK_GRAY,
        halign: (ci === 0 || typeof v === 'number') ? 'center' : 'left',
        border: border('thin'),
      });
    });
    for (let c = r.length + 1; c <= COLS; c++) {
      ws.getCell(row + 1 + ri, c).fill = solid(bg);
      ws.getCell(row + 1 + ri, c).border = border('thin');
    }
  });

  barCols.forEach(({ col, color }) => {
    if (limited.length > 0) {
      dataBar(ws, `${col}${row + 1}:${col}${row + limited.length}`, color || C.BLUE);
    }
  });

  return row + limited.length + 2;
}

/** Distribution frequency table. Returns next row. */
function distTable(ws, row, buckets) {
  ws.getRow(row).height = 18;
  ['Tier / Category', 'Count', '% of Total', 'Visual Bar'].forEach((h, i) => {
    write(ws, row, i + 1, h,
      { bg: C.DK_GRAY, bold: true, size: 9, color: C.WHITE, halign: 'center', border: border('thin', C.NAVY) });
  });
  for (let c = 5; c <= COLS; c++) ws.getCell(row, c).fill = solid(C.DK_GRAY);

  const maxC = Math.max(...buckets.map(b => b.count), 1);
  buckets.forEach((b, i) => {
    const bg = i % 2 === 0 ? C.ROW_A : C.ROW_B;
    ws.getRow(row + 1 + i).height = 18;

    write(ws, row + 1 + i, 1, b.label, { bg, size: 10, color: C.DK_GRAY, halign: 'left', border: border('thin') });
    write(ws, row + 1 + i, 2, b.count, { bg, size: 10, color: C.DK_GRAY, bold: true, halign: 'center', border: border('thin') });
    write(ws, row + 1 + i, 3, b.pct,   { bg, size: 10, color: C.BLUE, halign: 'center', border: border('thin') });

    const barLen = Math.round((b.count / maxC) * 22);
    write(ws, row + 1 + i, 4, '█'.repeat(barLen) + '░'.repeat(22 - barLen), {
      bg, border: border('thin'),
      font: 'Consolas', size: 8, color: C.BLUE, halign: 'left',
    });
    ws.getCell(row + 1 + i, 4).font = { name: 'Consolas', size: 8, color: clr(C.BLUE) };

    for (let c = 5; c <= COLS; c++) {
      ws.getCell(row + 1 + i, c).fill = solid(bg);
      ws.getCell(row + 1 + i, c).border = border('thin');
    }
  });

  if (buckets.length > 1) colorScale(ws, `B${row + 1}:B${row + buckets.length}`);
  return row + buckets.length + 2;
}

/** Insights block. Returns next row. */
function insights(ws, row, items) {
  const icons = ['💡', '📌', '⚡', '🎯', '🔍', '📊', '🏆', '📈'];
  items.forEach((text, i) => {
    ws.getRow(row + i).height = 22;
    merge(ws, row + i, 1, row + i, COLS, `  ${icons[i % icons.length]}  ${text}`, {
      bg: i % 2 === 0 ? C.ROW_A : C.ROW_B,
      size: 10, color: C.DK_GRAY, halign: 'left', valign: 'middle',
      border: border('thin'),
    });
  });
  return row + items.length + 2;
}

/** Footer. */
function footer(ws, row, note) {
  ws.getRow(row).height = 16;
  merge(ws, row, 1, row, COLS,
    `  ${note}  ·  Data sourced from public Instagram & YouTube APIs  ·  For research use only`,
    { bg: C.NAVY, size: 8, italic: true, color: C.MID_GRAY, halign: 'center' });
}

/** Sets column widths for the dashboard. */
function setCols(ws, widths) {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

/** Adds the tab and freezes panes. */
function initSheet(wb, name, tab = C.BLUE) {
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: tab } } });
  ws.views = [{ state: 'frozen', ySplit: 6, xSplit: 0, activeCell: 'A7' }];
  return ws;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PRESET SHEET BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function makeTopSheet(wb, sheetName, title, headers, rows, barCol, tabColor = C.GREEN) {
  const ws = initSheet(wb, sheetName, tabColor);
  setCols(ws, Array(COLS).fill(18));
  let r = hdr(ws, `📋 ${title}`, 'Pre-sorted view · Top performers ranked by key metric', now());
  r = sec(ws, r, `🏆 Top ${Math.min(rows.length, 25)} — Ranked by ${headers[headers.length - 2] || 'Metric'}`, C.DKGREEN);
  r = table(ws, r, headers, rows.slice(0, 25), [{ col: colLetter(headers.length - 1), color: C.GREEN }]);
  footer(ws, r + 2, `Showing top ${Math.min(rows.length, 25)} of ${rows.length} total entries`);
  return ws;
}

function makeDistSheet(wb, sheetName, title, sections, tabColor = C.PURPLE) {
  const ws = initSheet(wb, sheetName, tabColor);
  setCols(ws, Array(COLS).fill(18));
  let r = hdr(ws, `📋 ${title}`, 'Distribution & frequency analysis across all collected data', now());
  for (const { heading, buckets } of sections) {
    r = sec(ws, r, `📊 ${heading}`, C.PURPLE);
    r = distTable(ws, r, buckets);
    r = gap(ws, r);
  }
  footer(ws, r + 1, `Distribution analysis generated automatically from scraped data`);
  return ws;
}

function colLetter(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(64 + (n % 26 || 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function now() {
  return new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });
}

function bucketize(nums, tiers) {
  // tiers = [{ label, min, max }]
  const total = nums.length;
  return tiers.map(t => {
    const count = nums.filter(n => n >= t.min && n < t.max).length;
    return { label: t.label, count, pct: pct(count, total) };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1.  YOUTUBE COMMENTS DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export function addYouTubeCommentsDashboard(wb) {
  const comments  = readSheet(wb, 'Comments');
  const videoInfo = readSheet(wb, 'Video Info');
  if (comments.length === 0) return;

  const ts = now();

  // ── Stats ────────────────────────────────────────────────────────────────
  const total      = comments.length;
  const replies    = comments.filter(c => c['Is Reply'] === 'yes').length;
  const topLevel   = total - replies;
  const authors    = freq(comments.map(c => c['Author']));
  const uniqueAuth = authors.length;
  const likes      = comments.map(c => toNum(c['Likes']));
  const totalLikes = likes.reduce((a, b) => a + b, 0);
  const avgLikes   = avg(likes).toFixed(1);
  const maxLikes   = Math.max(...likes, 0);
  const videoTitle = videoInfo[0]?.['Title'] || comments[0]?.['Video Title'] || 'Video';
  const viewCount  = videoInfo[0]?.['View Count'] || '—';
  const dates      = comments.map(c => String(c['Date'] || '')).filter(Boolean);

  // ── Dashboard sheet ──────────────────────────────────────────────────────
  const ws = initSheet(wb, '📊 Dashboard', C.NAVY);
  setCols(ws, [4, 14, 14, 14, 8, 14, 14, 14, 6, 14, 14, 14, 6, 14]);

  let r = hdr(ws, '💬 YouTube Comments Analytics', `"${videoTitle.slice(0, 80)}"`, ts);

  const sheets = [
    { label: '📊 Dashboard', sheet: '📊 Dashboard' },
    { label: '🏆 Top Commenters', sheet: '📋 Top Commenters' },
    { label: '📊 Distribution', sheet: '📋 Distribution' },
    { label: '📄 Comments Data', sheet: 'Comments' },
    { label: 'ℹ Video Info', sheet: 'Video Info' },
  ];
  r = nav(ws, r, sheets);

  r = sec(ws, r, '📈 KEY METRICS AT A GLANCE', C.TEAL);
  r = kpiRow(ws, r, [
    { label: 'Total Comments', value: fmt(total),      sub: `${uniqueAuth} unique authors`, color: C.NAVY },
    { label: 'Top-Level / Replies', value: `${topLevel} / ${replies}`, sub: pct(replies, total) + ' are replies', color: C.BLUE },
    { label: 'Total Likes',     value: fmt(totalLikes), sub: `avg ${avgLikes} per comment`, color: C.TEAL },
    { label: 'Most Liked',      value: fmt(maxLikes),   sub: 'likes on single comment',     color: C.PURPLE },
  ]);
  r = gap(ws, r);

  // Video context card
  r = sec(ws, r, 'ℹ️  VIDEO CONTEXT', C.DK_GRAY);
  const ctxRows = [
    ['Title', videoTitle],
    ['View Count', viewCount],
    ['Like Count', videoInfo[0]?.['Like Count'] || '—'],
    ['Upload Date', videoInfo[0]?.['Upload Date'] || '—'],
    ['Channel', videoInfo[0]?.['Channel'] || '—'],
    ['Declared Comment Count', videoInfo[0]?.['Comment Count'] || '—'],
    ['Scraped Comment Count', total],
  ];
  ctxRows.forEach(([k, v], i) => {
    ws.getRow(r + i).height = 18;
    write(ws, r + i, 1, k, { bg: C.BLUE, bold: true, size: 9, color: C.WHITE, halign: 'left', border: border('thin', C.NAVY) });
    merge(ws, r + i, 2, r + i, COLS, String(v ?? ''), { bg: i % 2 === 0 ? C.ROW_A : C.ROW_B, size: 10, color: C.DK_GRAY, halign: 'left', border: border('thin') });
  });
  r += ctxRows.length + 2;

  r = sec(ws, r, '🏆 TOP 15 COMMENTERS', C.NAVY);
  const topAuthRows = authors.slice(0, 15).map(([ name, cnt ], i) => [
    i + 1, String(name || '(unknown)'), cnt, pct(cnt, total),
  ]);
  r = table(ws, r,
    ['#', 'Author', 'Comment Count', '% of Total'],
    topAuthRows, [{ col: 'C', color: C.SKY }]);

  r = sec(ws, r, '❤️  MOST LIKED COMMENTS', C.ORANGE);
  const topLikedRows = comments
    .filter(c => c['Is Reply'] !== 'yes')
    .map(c => ({ ...c, _likes: toNum(c['Likes']) }))
    .sort((a, b) => b._likes - a._likes)
    .slice(0, 10)
    .map((c, i) => [
      i + 1,
      String(c['Author'] || '').slice(0, 30),
      c._likes,
      String(c['Comment Text'] || c['text'] || '').slice(0, 80) + '…',
    ]);
  r = table(ws, r, ['#', 'Author', 'Likes', 'Comment Preview'], topLikedRows, [{ col: 'C', color: C.AMBER }]);

  // ── Engagement metrics ───────────────────────────────────────────────────
  r = sec(ws, r, '📊 ENGAGEMENT ANALYSIS', C.TEAL);
  const likeRate        = total > 0 ? (likes.filter(l=>l>0).length / total * 100).toFixed(1) : '0';
  const highEngagement  = likes.filter(l => l >= 10).length;
  const viralComments   = likes.filter(l => l >= 100).length;
  const topAuthorShare  = total > 0 ? (authors.slice(0,10).reduce((a,[,c])=>a+c,0) / total * 100).toFixed(1) : '0';
  const engagementRows  = [
    ['Comments with ≥1 like',     `${likes.filter(l=>l>0).length.toLocaleString()}`, pct(likes.filter(l=>l>0).length, total)],
    ['Comments with ≥10 likes',   `${highEngagement.toLocaleString()}`, pct(highEngagement, total)],
    ['Viral comments (≥100 likes)',`${viralComments.toLocaleString()}`, pct(viralComments, total)],
    ['Top-10 author concentration',`${topAuthorShare}%`, 'of all comments'],
    ['Reply / top-level ratio',    `${replies}:${topLevel}`, replies > topLevel ? '↑ Deep threads' : '↑ Broad discussion'],
    ['Avg comment likes',          avgLikes, `max: ${fmt(maxLikes)}`],
  ];
  engagementRows.forEach(([metric, value, note], i) => {
    ws.getRow(r+i).height = 18;
    write(ws,r+i,1,metric,{bg:i%2===0?C.ROW_A:C.ROW_B,size:10,color:C.DK_GRAY,halign:'left',border:border('thin')});
    write(ws,r+i,2,value, {bg:i%2===0?C.ROW_A:C.ROW_B,bold:true,size:10,color:C.BLUE,halign:'center',border:border('thin')});
    merge(ws,r+i,3,r+i,COLS,note,{bg:i%2===0?C.ROW_A:C.ROW_B,size:9,italic:true,color:C.MID_GRAY,halign:'left',border:border('thin')});
  });
  r += engagementRows.length + 2;

  r = sec(ws, r, '💡 AUTO-GENERATED INSIGHTS', C.DKGREEN);
  const ins = [
    `${total.toLocaleString()} comments collected from "${videoTitle.slice(0, 50)}", spanning ${uniqueAuth.toLocaleString()} unique contributors.`,
    `Reply rate is ${pct(replies, total)} — ${replies > topLevel ? 'unusually high discussion depth' : 'typical for this content type'}.`,
    `Top commenter "${authors[0]?.[0] || 'unknown'}" posted ${authors[0]?.[1] || 0} comments (${pct(authors[0]?.[1] || 0, total)} of total).`,
    `Average likes per comment: ${avgLikes}. The most liked comment received ${fmt(maxLikes)} likes.`,
    `Top 10 authors contributed ${pct(authors.slice(0,10).reduce((a: any, r: any) => a + r[2], 0), total)} of all comments — concentration metric.`,
    `${comments.filter(c => toNum(c['Likes']) === 0).length.toLocaleString()} comments (${pct(comments.filter(c => toNum(c['Likes']) === 0).length, total)}) received zero likes.`,
    `${viralComments} viral comment(s) with 100+ likes — exceptional community resonance.`,
    `Engagement rate (comments with ≥1 like): ${likeRate}% of all comments.`,
  ];
  r = insights(ws, r, ins);
  footer(ws, r, `Comments Dashboard · ${total} records · ${ts}`);

  // ── Preset 1: Top Commenters ────────────────────────────────────────────
  makeTopSheet(wb, '📋 Top Commenters', 'Top Commenters',
    ['Rank', 'Author', 'Comments', '% of Total'],
    authors.slice(0, 50).map(([name, cnt], i) => [i + 1, String(name || ''), cnt, pct(cnt, total)]),
    'C', C.SKY);

  // ── Preset 2: Distribution ──────────────────────────────────────────────
  const likeBuckets = [
    [0,0], [1,1], [2,5], [6,20], [21,100], [101,1000], [1001, Infinity]
  ].map(([lo, hi]) => ({
    label: hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}–${hi}`,
    count: likes.filter(n => n >= lo && n <= hi).length,
    pct:   pct(likes.filter(n => n >= lo && n <= hi).length, total),
  }));

  const authorFreqBuckets = [
    { label: '1 comment only',  count: authors.filter(([,c]) => c === 1).length },
    { label: '2–5 comments',    count: authors.filter(([,c]) => c >= 2 && c <= 5).length },
    { label: '6–20 comments',   count: authors.filter(([,c]) => c >= 6 && c <= 20).length },
    { label: '21–50 comments',  count: authors.filter(([,c]) => c >= 21 && c <= 50).length },
    { label: '50+ comments',    count: authors.filter(([,c]) => c > 50).length },
  ].map(b => ({ ...b, pct: pct(b.count, uniqueAuth) }));

  const engagementBuckets = [
    { label: 'No likes (0)',        count: likes.filter(l=>l===0).length },
    { label: 'Low (1–9)',           count: likes.filter(l=>l>=1&&l<=9).length },
    { label: 'Medium (10–99)',      count: likes.filter(l=>l>=10&&l<100).length },
    { label: 'High (100–999)',      count: likes.filter(l=>l>=100&&l<1000).length },
    { label: 'Viral (1000+)',       count: likes.filter(l=>l>=1000).length },
  ].map(b => ({ ...b, pct: pct(b.count, total) }));

  makeDistSheet(wb, '📋 Distribution', 'Comments Distribution', [
    { heading: 'Likes per Comment Distribution', buckets: likeBuckets },
    { heading: 'Engagement Tiers',               buckets: engagementBuckets },
    { heading: 'Author Activity Frequency',      buckets: authorFreqBuckets },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2.  YOUTUBE SEARCH RESULTS DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export function addYouTubeSearchDashboard(wb) {
  const data = readSheet(wb, 'Search Results');
  if (data.length === 0) return;
  const ts = now();

  const keywords   = [...new Set(data.map(r => r['Keyword']))].filter(Boolean);
  const channels   = freq(data.map(r => r['Channel']));
  const views      = data.map(r => toNum(r['View Count']));
  const totalViews = views.reduce((a, b) => a + b, 0);
  const avgViews   = avg(views);
  const maxViews   = Math.max(...views, 0);

  const ws = initSheet(wb, '📊 Dashboard', C.NAVY);
  setCols(ws, [4, 14, 14, 14, 8, 14, 14, 14, 6, 14, 14, 14, 6, 14]);

  let r = hdr(ws, '🔍 YouTube Search Analytics',
    `Keywords: ${keywords.slice(0, 5).join(' · ')}${keywords.length > 5 ? ' …' : ''}`, ts);

  r = nav(ws, r, [
    { label: '📊 Dashboard', sheet: '📊 Dashboard' },
    { label: '🏆 Top Videos', sheet: '📋 Top Videos' },
    { label: '📊 Distribution', sheet: '📋 Distribution' },
    { label: '📄 Raw Results', sheet: 'Search Results' },
  ]);

  r = sec(ws, r, '📈 KEY METRICS', C.TEAL);
  r = kpiRow(ws, r, [
    { label: 'Total Results',   value: fmt(data.length),    sub: `${keywords.length} keyword(s)`,     color: C.NAVY },
    { label: 'Unique Channels', value: fmt(channels.length), sub: 'distinct content creators',         color: C.BLUE },
    { label: 'Avg Views',       value: fmt(Math.round(avgViews)), sub: `max: ${fmt(maxViews)}`,       color: C.TEAL },
    { label: 'Total Views',     value: fmt(totalViews),     sub: 'across all results',                color: C.PURPLE },
  ]);
  r = gap(ws, r);

  r = sec(ws, r, '🎬 TOP 15 VIDEOS BY VIEW COUNT', C.NAVY);
  const sortedByViews = data
    .map(d => ({ ...d, _views: toNum(d['View Count']) }))
    .sort((a, b) => b._views - a._views)
    .slice(0, 15);
  r = table(ws, r, ['#', 'Title', 'Channel', 'Views', 'Duration', 'Upload Date'],
    sortedByViews.map((d, i) => [
      i + 1,
      String(d['Title'] || '').slice(0, 55),
      String(d['Channel'] || '').slice(0, 28),
      d._views,
      String(d['Duration'] || ''),
      String(d['Upload Date'] || ''),
    ]),
    [{ col: 'D', color: C.SKY }]);

  r = sec(ws, r, '📺 TOP 10 CHANNELS BY APPEARANCES', C.ORANGE);
  r = table(ws, r, ['#', 'Channel Name', 'Appearances', '% of Results'],
    channels.slice(0, 10).map(([name, cnt], i) => [i + 1, String(name || ''), cnt, pct(cnt, data.length)]),
    [{ col: 'C', color: C.AMBER }]);

  r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
  r = insights(ws, r, [
    `${data.length} results collected across ${keywords.length} keyword(s): ${keywords.slice(0,3).join(', ')}${keywords.length > 3 ? '…' : ''}.`,
    `Top channel "${channels[0]?.[0] || '—'}" appeared ${channels[0]?.[1] || 0} times (${pct(channels[0]?.[1]||0, data.length)}) in results.`,
    `Most-viewed result: "${sortedByViews[0]?.['Title']?.slice(0, 60) || '—'}" with ${fmt(sortedByViews[0]?._views || 0)} views.`,
    `${views.filter(v => v === 0).length} results had unreadable/missing view counts. ${views.filter(v => v > 1e6).length} results exceeded 1M views.`,
    `Channel diversity index: top-10 channels account for ${pct(channels.slice(0,10).reduce((a,[,c])=>a+c,0), data.length)} of all results.`,
  ]);
  footer(ws, r, `Search Dashboard · ${data.length} results · ${ts}`);

  // Presets
  makeTopSheet(wb, '📋 Top Videos', 'Top Videos by Views',
    ['Rank', 'Title', 'Channel', 'View Count', 'Duration', 'Upload Date'],
    sortedByViews.slice(0, 50).map((d, i) => [i+1, String(d['Title']||'').slice(0,55), String(d['Channel']||''), d._views, d['Duration']||'', d['Upload Date']||'']),
    'D', C.SKY);

  const viewTiers = [
    { label: '< 1K views',        count: views.filter(v => v < 1e3).length },
    { label: '1K – 100K views',   count: views.filter(v => v >= 1e3 && v < 1e5).length },
    { label: '100K – 1M views',   count: views.filter(v => v >= 1e5 && v < 1e6).length },
    { label: '1M – 100M views',   count: views.filter(v => v >= 1e6 && v < 1e8).length },
    { label: '100M+ views',       count: views.filter(v => v >= 1e8).length },
  ].map(b => ({ ...b, pct: pct(b.count, data.length) }));

  makeDistSheet(wb, '📋 Distribution', 'Search Results Distribution', [
    { heading: 'View Count Tiers', buckets: viewTiers },
    { heading: 'Top Channels by Frequency', buckets: channels.slice(0,10).map(([n,c])=>({ label: String(n), count: c, pct: pct(c, data.length) })) },
    { heading: 'Results per Keyword', buckets: keywords.map(k => { const cnt = data.filter(r=>r['Keyword']===k).length; return { label: k, count: cnt, pct: pct(cnt, data.length) }; }) },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3.  YOUTUBE CHANNEL SEARCH DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export function addChannelSearchDashboard(wb) {
  const data = readSheet(wb, 'Channel Search');
  if (data.length === 0) return;
  const ts = now();

  const keywords   = [...new Set(data.map(r => r['Keyword']))].filter(Boolean);
  const verified   = data.filter(r => String(r['Verified']).toLowerCase() === 'yes').length;
  const subs       = data.map(r => toNum(r['Subscribers']));
  const avgSubs    = avg(subs);
  const maxSubs    = Math.max(...subs, 0);
  const vidCounts  = data.map(r => toNum(r['Video Count']));

  const ws = initSheet(wb, '📊 Dashboard', C.NAVY);
  setCols(ws, [4, 14, 14, 14, 8, 14, 14, 14, 6, 14, 14, 14, 6, 14]);

  let r = hdr(ws, '📺 YouTube Channel Search Analytics',
    `Keywords: ${keywords.slice(0,5).join(' · ')}`, ts);

  r = nav(ws, r, [
    { label: '📊 Dashboard',    sheet: '📊 Dashboard' },
    { label: '🏆 Top Channels', sheet: '📋 Top Channels' },
    { label: '📊 Distribution', sheet: '📋 Distribution' },
    { label: '📄 Raw Data',     sheet: 'Channel Search' },
  ]);

  r = sec(ws, r, '📈 KEY METRICS', C.TEAL);
  r = kpiRow(ws, r, [
    { label: 'Channels Found',  value: fmt(data.length),  sub: `from ${keywords.length} keyword(s)`, color: C.NAVY },
    { label: 'Verified ✓',      value: fmt(verified),     sub: pct(verified, data.length) + ' of total', color: C.GREEN },
    { label: 'Avg Subscribers', value: fmt(Math.round(avgSubs)), sub: `max: ${fmt(maxSubs)}`, color: C.TEAL },
    { label: 'Avg Videos',      value: fmt(Math.round(avg(vidCounts))), sub: 'per channel', color: C.PURPLE },
  ]);
  r = gap(ws, r);

  const sortedBySubs = data
    .map(d => ({ ...d, _subs: toNum(d['Subscribers']) }))
    .sort((a, b) => b._subs - a._subs);

  r = sec(ws, r, '🏆 TOP 15 CHANNELS BY SUBSCRIBERS', C.NAVY);
  r = table(ws, r, ['#', 'Channel Name', 'Subscribers', 'Videos', 'Verified', 'Keyword'],
    sortedBySubs.slice(0, 15).map((d, i) => [
      i + 1,
      String(d['Channel Name'] || '').slice(0, 40),
      d._subs,
      toNum(d['Video Count']),
      String(d['Verified'] || ''),
      String(d['Keyword'] || ''),
    ]),
    [{ col: 'C', color: C.SKY }]);

  r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
  r = insights(ws, r, [
    `${data.length} channels found across ${keywords.length} keyword(s). ${verified} (${pct(verified, data.length)}) carry a verified badge.`,
    `Largest channel: "${sortedBySubs[0]?.['Channel Name']||'—'}" with ${fmt(sortedBySubs[0]?._subs||0)} subscribers.`,
    `Average subscribers: ${fmt(Math.round(avgSubs))}. Median subscriber count indicates general audience size.`,
    `${subs.filter(s => s > 1e6).length} channels have over 1M subscribers — premium content tier.`,
    `${subs.filter(s => s < 1e4).length} channels have fewer than 10K subscribers — emerging/niche creators.`,
  ]);
  footer(ws, r, `Channel Search Dashboard · ${data.length} channels · ${ts}`);

  makeTopSheet(wb, '📋 Top Channels', 'Top Channels by Subscribers',
    ['Rank', 'Channel Name', 'Subscribers', 'Videos', 'Verified'],
    sortedBySubs.slice(0, 50).map((d, i) => [i+1, String(d['Channel Name']||''), d._subs, toNum(d['Video Count']), d['Verified']||'']),
    'C', C.SKY);

  const subTiers = [
    { label: '< 1K subs',      count: subs.filter(s => s < 1e3).length },
    { label: '1K–10K subs',    count: subs.filter(s => s >= 1e3 && s < 1e4).length },
    { label: '10K–100K subs',  count: subs.filter(s => s >= 1e4 && s < 1e5).length },
    { label: '100K–1M subs',   count: subs.filter(s => s >= 1e5 && s < 1e6).length },
    { label: '1M–10M subs',    count: subs.filter(s => s >= 1e6 && s < 1e7).length },
    { label: '10M+ subs',      count: subs.filter(s => s >= 1e7).length },
  ].map(b => ({ ...b, pct: pct(b.count, data.length) }));

  const vidTiers = [
    { label: '< 10 videos',     count: vidCounts.filter(v => v < 10).length },
    { label: '10–50 videos',    count: vidCounts.filter(v => v >= 10 && v < 50).length },
    { label: '50–200 videos',   count: vidCounts.filter(v => v >= 50 && v < 200).length },
    { label: '200–1000 videos', count: vidCounts.filter(v => v >= 200 && v < 1000).length },
    { label: '1000+ videos',    count: vidCounts.filter(v => v >= 1000).length },
  ].map(b => ({ ...b, pct: pct(b.count, data.length) }));

  makeDistSheet(wb, '📋 Distribution', 'Channel Distribution', [
    { heading: 'Subscriber Tier Breakdown', buckets: subTiers },
    { heading: 'Video Count Tier Breakdown', buckets: vidTiers },
    { heading: 'Verified vs Unverified', buckets: [
      { label: 'Verified ✓', count: verified, pct: pct(verified, data.length) },
      { label: 'Unverified',  count: data.length - verified, pct: pct(data.length - verified, data.length) },
    ]},
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  4.  YOUTUBE CHANNEL VIDEOS DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export function addChannelVideosDashboard(wb) {
  const videos  = readSheet(wb, 'Channel Videos');
  const chanInfo = readSheet(wb, 'Channel Info');
  if (videos.length === 0) return;
  const ts = now();

  const channelName = chanInfo[0]?.['Channel Name'] || videos[0]?.['Channel Name'] || 'Channel';
  const channelSubs = chanInfo[0]?.['Subscribers'] || '—';
  const views   = videos.map(v => toNum(v['View Count']));
  const totalV  = views.reduce((a, b) => a + b, 0);
  const avgV    = avg(views);
  const maxV    = Math.max(...views, 0);
  const sortedVids = videos
    .map(v => ({ ...v, _views: toNum(v['View Count']) }))
    .sort((a, b) => b._views - a._views);

  const ws = initSheet(wb, '📊 Dashboard', C.NAVY);
  setCols(ws, [4, 14, 14, 14, 8, 14, 14, 14, 6, 14, 14, 14, 6, 14]);

  let r = hdr(ws, '📺 Channel Video Analytics', `Channel: ${channelName}`, ts);

  r = nav(ws, r, [
    { label: '📊 Dashboard',   sheet: '📊 Dashboard' },
    { label: '🏆 Top Videos',  sheet: '📋 Top Videos' },
    { label: '📊 Distribution',sheet: '📋 Distribution' },
    { label: '📄 All Videos',  sheet: 'Channel Videos' },
  ]);

  r = sec(ws, r, '📈 KEY METRICS', C.TEAL);
  r = kpiRow(ws, r, [
    { label: 'Videos Scraped', value: fmt(videos.length),   sub: channelSubs + ' subscribers', color: C.NAVY },
    { label: 'Total Views',    value: fmt(totalV),          sub: 'cumulative across all videos', color: C.BLUE },
    { label: 'Avg Views',      value: fmt(Math.round(avgV)), sub: `max: ${fmt(maxV)}`,          color: C.TEAL },
    { label: 'Most Viewed',    value: String(sortedVids[0]?.['Title']||'—').slice(0, 25) + '…', sub: fmt(sortedVids[0]?._views||0) + ' views', color: C.PURPLE },
  ]);
  r = gap(ws, r);

  r = sec(ws, r, '🏆 TOP 15 VIDEOS BY VIEWS', C.NAVY);
  r = table(ws, r, ['#', 'Title', 'Views', 'Duration', 'Upload Date'],
    sortedVids.slice(0, 15).map((v, i) => [
      i + 1,
      String(v['Title'] || '').slice(0, 60),
      v._views,
      String(v['Duration'] || ''),
      String(v['Upload Date'] || ''),
    ]),
    [{ col: 'C', color: C.SKY }]);

  r = sec(ws, r, '📅 MOST RECENT 10 UPLOADS', C.ORANGE);
  const recent = [...videos].reverse().slice(0, 10);
  r = table(ws, r, ['#', 'Title', 'Views', 'Duration', 'Upload Date'],
    recent.map((v, i) => [
      i + 1,
      String(v['Title'] || '').slice(0, 60),
      toNum(v['View Count']),
      String(v['Duration'] || ''),
      String(v['Upload Date'] || ''),
    ]),
    [{ col: 'C', color: C.AMBER }]);

  r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
  r = insights(ws, r, [
    `"${channelName}" has ${videos.length} videos scraped with ${fmt(totalV)} cumulative views.`,
    `Most-viewed video: "${sortedVids[0]?.['Title']?.slice(0,70)||'—'}" (${fmt(sortedVids[0]?._views||0)} views).`,
    `Average views per video: ${fmt(Math.round(avgV))}. ${views.filter(v=>v > avgV*2).length} videos perform above 2× average.`,
    `${views.filter(v => v === 0).length} videos have 0 or unreadable view counts.`,
    `Top 10% of videos account for ${pct(sortedVids.slice(0, Math.ceil(videos.length*0.1)).reduce((a,v)=>a+v._views,0), totalV)} of total views — content concentration metric.`,
  ]);
  footer(ws, r, `Channel Videos Dashboard · ${videos.length} videos · ${ts}`);

  makeTopSheet(wb, '📋 Top Videos', 'Top Videos by Views',
    ['Rank', 'Title', 'View Count', 'Duration', 'Upload Date'],
    sortedVids.slice(0, 50).map((v, i) => [i+1, String(v['Title']||'').slice(0,60), v._views, v['Duration']||'', v['Upload Date']||'']),
    'C', C.SKY);

  const viewTiers = [
    { label: '< 1K views',      count: views.filter(v => v < 1e3).length },
    { label: '1K–10K views',    count: views.filter(v => v >= 1e3 && v < 1e4).length },
    { label: '10K–100K views',  count: views.filter(v => v >= 1e4 && v < 1e5).length },
    { label: '100K–1M views',   count: views.filter(v => v >= 1e5 && v < 1e6).length },
    { label: '1M+ views',       count: views.filter(v => v >= 1e6).length },
  ].map(b => ({ ...b, pct: pct(b.count, videos.length) }));

  makeDistSheet(wb, '📋 Distribution', 'Channel Videos Distribution', [
    { heading: 'View Count Distribution', buckets: viewTiers },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  5.  INSTAGRAM DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export function addInstagramDashboard(wb) {
  const summary  = readSheet(wb, 'Summary');
  const posts    = readSheet(wb, 'Last Posts');
  const stories  = readSheet(wb, 'Last Stories');
  if (summary.length === 0 && posts.length === 0) return;
  const ts = now();

  // Reconstruct profiles from summary (6 rows each: username, fullname, desc, posts, followers, following)
  const profiles = [];
  let cur: any = {};
  summary.forEach(row => {
    if (!row['Profile'] && !row['Field']) return;
    const field = String(row['Field'] || '').toLowerCase();
    if (field === 'username') {
      if (cur.username) profiles.push(cur);
      cur = { profile: row['Profile'], username: row['Value'] };
    } else if (field === 'followers') cur.followers = toNum(row['Value']);
    else if (field === 'following')   cur.following = toNum(row['Value']);
    else if (field === 'posts')       cur.posts = toNum(row['Value']);
    else if (field === 'full name')   cur.fullName = row['Value'];
  });
  if (cur.username) profiles.push(cur);

  const profileCount = profiles.length;
  const followers    = profiles.map(p => p.followers || 0);
  const totalFlw     = followers.reduce((a, b) => a + b, 0);
  const avgFlw       = avg(followers);
  const postLikes    = posts.map(p => toNum(p['Likes']));
  const totalLikes   = postLikes.reduce((a, b) => a + b, 0);
  const avgLikes     = avg(postLikes);
  const storyCount   = stories.length;
  const mediaTypes   = freq(stories.map(s => s['Media Type'] || 'photo'));

  const ws = initSheet(wb, '📊 Dashboard', C.NAVY);
  setCols(ws, [4, 14, 14, 14, 8, 14, 14, 14, 6, 14, 14, 14, 6, 14]);

  let r = hdr(ws, '📸 Instagram Analytics Dashboard',
    `Profiles: ${profiles.map(p => '@' + (p.username||p.profile||'')).slice(0,5).join(' · ')}`, ts);

  r = nav(ws, r, [
    { label: '📊 Dashboard',   sheet: '📊 Dashboard' },
    { label: '🏆 Top Profiles',sheet: '📋 Top Profiles' },
    { label: '📊 Distribution',sheet: '📋 Distribution' },
    { label: '📄 Summary',     sheet: 'Summary' },
    { label: '📷 Posts',       sheet: 'Last Posts' },
    { label: '🎬 Stories',     sheet: 'Last Stories' },
  ]);

  r = sec(ws, r, '📈 KEY METRICS', C.TEAL);
  r = kpiRow(ws, r, [
    { label: 'Profiles Scraped', value: fmt(profileCount), sub: `${posts.length} posts total`, color: C.NAVY },
    { label: 'Total Followers',  value: fmt(totalFlw),     sub: `avg ${fmt(Math.round(avgFlw))}`, color: C.BLUE },
    { label: 'Total Post Likes', value: fmt(totalLikes),   sub: `avg ${fmt(Math.round(avgLikes))}/post`, color: C.TEAL },
    { label: 'Stories Scraped',  value: fmt(storyCount),   sub: `${mediaTypes[0]?.[0]||'photo'} most common`, color: C.PURPLE },
  ]);
  r = gap(ws, r);

  r = sec(ws, r, '👤 PROFILE SUMMARY', C.NAVY);
  r = table(ws, r, ['#', 'Username', 'Full Name', 'Posts', 'Followers', 'Following'],
    profiles.sort((a,b)=>(b.followers||0)-(a.followers||0)).map((p, i) => [
      i + 1,
      '@' + String(p.username || p.profile || ''),
      String(p.fullName || '').slice(0, 30),
      p.posts || 0,
      p.followers || 0,
      p.following || 0,
    ]),
    [{ col: 'E', color: C.SKY }]);

  if (posts.length > 0) {
    r = sec(ws, r, '❤️  TOP 15 POSTS BY LIKES', C.ORANGE);
    const topPosts = posts
      .map(p => ({ ...p, _likes: toNum(p['Likes']) }))
      .sort((a, b) => b._likes - a._likes)
      .slice(0, 15);
    r = table(ws, r, ['#', 'Profile', 'Likes', 'Comments', 'Timestamp', 'Caption Preview'],
      topPosts.map((p, i) => [
        i + 1,
        String(p['Profile'] || ''),
        p._likes,
        toNum(p['Comments Count']),
        String(p['Timestamp'] || '').slice(0, 19),
        String(p['Description'] || '').slice(0, 60),
      ]),
      [{ col: 'C', color: C.AMBER }]);
  }

  r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
  const topProfile = profiles.sort((a,b)=>(b.followers||0)-(a.followers||0))[0];
  r = insights(ws, r, [
    `${profileCount} Instagram profile(s) scraped with a combined ${fmt(totalFlw)} followers.`,
    `Largest account: "@${topProfile?.username||'—'}" with ${fmt(topProfile?.followers||0)} followers.`,
    `${posts.length} posts collected. Average likes per post: ${fmt(Math.round(avgLikes))}.`,
    `${storyCount} stories collected. Story media breakdown: ${mediaTypes.map(([t,c])=>`${t}: ${c}`).join(', ') || 'N/A'}.`,
    `${posts.filter(p=>toNum(p['Comments Count'])>0).length} posts have visible comment threads.`,
    `Follower-to-following ratio (top profile): ${topProfile ? (topProfile.followers/Math.max(topProfile.following,1)).toFixed(2) + ':1' : '—'}.`,
  ]);
  footer(ws, r, `Instagram Dashboard · ${profileCount} profiles · ${ts}`);

  // Preset 1: Top Profiles
  makeTopSheet(wb, '📋 Top Profiles', 'Profiles by Followers',
    ['Rank', 'Username', 'Full Name', 'Posts', 'Followers', 'Following'],
    profiles.map((p, i) => [i+1, '@'+(p.username||''), p.fullName||'', p.posts||0, p.followers||0, p.following||0]),
    'E', C.SKY);

  // Preset 2: Distribution
  const flwTiers = [
    { label: '< 1K followers',      count: followers.filter(f=>f<1e3).length },
    { label: '1K–10K followers',     count: followers.filter(f=>f>=1e3&&f<1e4).length },
    { label: '10K–100K followers',   count: followers.filter(f=>f>=1e4&&f<1e5).length },
    { label: '100K–1M followers',    count: followers.filter(f=>f>=1e5&&f<1e6).length },
    { label: '1M+ followers',        count: followers.filter(f=>f>=1e6).length },
  ].map(b => ({ ...b, pct: pct(b.count, profileCount || 1) }));

  const likeTiers = [
    { label: '0 likes',       count: postLikes.filter(l=>l===0).length },
    { label: '1–100 likes',   count: postLikes.filter(l=>l>=1&&l<=100).length },
    { label: '101–1K likes',  count: postLikes.filter(l=>l>100&&l<=1000).length },
    { label: '1K–10K likes',  count: postLikes.filter(l=>l>1000&&l<=10000).length },
    { label: '10K+ likes',    count: postLikes.filter(l=>l>10000).length },
  ].map(b => ({ ...b, pct: pct(b.count, posts.length || 1) }));

  makeDistSheet(wb, '📋 Distribution', 'Instagram Distribution', [
    { heading: 'Follower Count Tiers', buckets: flwTiers },
    { heading: 'Post Likes Distribution', buckets: likeTiers },
    ...(storyCount > 0 ? [{ heading: 'Story Media Types', buckets: mediaTypes.map(([t,c])=>({ label: t, count: c, pct: pct(c, storyCount) })) }] : []),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  6.  REDDIT DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export function addRedditDashboard(wb, mode = 'post-search') {
  // Determine data sheets based on mode
  const postsData    = readSheet(wb, 'Post Search Results').concat(readSheet(wb, 'Posts'));
  const subsData     = readSheet(wb, 'Subreddit Results');
  const commentsData = readSheet(wb, 'Comments');
  const subInfoData  = readSheet(wb, 'Subreddit Info');

  const hasData = postsData.length > 0 || subsData.length > 0 || commentsData.length > 0;
  if (!hasData) return;

  const ts = now();

  const ws = initSheet(wb, '📊 Dashboard', C.NAVY);
  setCols(ws, [4, 14, 14, 14, 8, 14, 14, 14, 6, 14, 14, 14, 6, 14]);

  const titleMap = {
    'post-search':   '🟠 Reddit Post Search Analytics',
    'sub-search':    '🟠 Reddit Subreddit Search Analytics',
    'subreddit':     '🟠 Reddit Subreddit Analytics',
    'post-comments': '🟠 Reddit Comment Analytics',
  };

  let r = hdr(ws, titleMap[mode] || '🟠 Reddit Analytics',
    mode === 'subreddit' ? `r/${subInfoData[0]?.['Name'] || ''}` :
    mode === 'post-comments' ? `${commentsData[0]?.['Post Title']?.slice(0,70) || ''}` :
    `${postsData.length + subsData.length + commentsData.length} records collected`, ts);

  // Navigation
  const navLinks = [{ label: '📊 Dashboard', sheet: '📊 Dashboard' }];
  if (postsData.length)    navLinks.push({ label: '📄 Posts', sheet: wb.getWorksheet('Post Search Results') ? 'Post Search Results' : 'Posts' });
  if (subsData.length)     navLinks.push({ label: '📄 Subreddits', sheet: 'Subreddit Results' });
  if (commentsData.length) navLinks.push({ label: '💬 Comments', sheet: 'Comments' });
  r = nav(ws, r, navLinks);

  // ── Posts analytics ────────────────────────────────────────────────────────
  if (postsData.length > 0) {
    const scores      = postsData.map(p => toNum(p['Score']));
    const comments    = postsData.map(p => toNum(p['Num Comments']));
    const authors     = freq(postsData.map(p => p['Author']));
    const subreddits  = freq(postsData.map(p => p['Subreddit']));
    const flairs      = freq(postsData.map(p => p['Flair']).filter(Boolean));
    const totalScore  = scores.reduce((a,b)=>a+b,0);
    const totalComments=comments.reduce((a,b)=>a+b,0);
    const videos      = postsData.filter(p => String(p['Is Video']).toLowerCase()==='true').length;
    const textPosts   = postsData.filter(p => String(p['Is Text Post']).toLowerCase()==='true').length;

    r = sec(ws, r, '📈 KEY METRICS', C.ORANGE);
    r = kpiRow(ws, r, [
      { label: 'Total Posts',       value: fmt(postsData.length), sub: `${authors.length} unique authors`,       color: C.NAVY   },
      { label: 'Total Score',       value: fmt(totalScore),       sub: `avg ${fmt(Math.round(avg(scores)))}`,    color: C.ORANGE },
      { label: 'Total Comments',    value: fmt(totalComments),    sub: `avg ${fmt(Math.round(avg(comments)))}`,  color: C.TEAL   },
      { label: 'Video / Text Posts',value: `${videos}/${textPosts}`, sub: `${pct(videos, postsData.length)} video`, color: C.PURPLE },
    ]);
    r = gap(ws, r);

    r = sec(ws, r, '🏆 TOP 15 POSTS BY SCORE', C.NAVY);
    const topPosts = postsData.map(p=>({...p,_score:toNum(p['Score'])})).sort((a,b)=>b._score-a._score).slice(0,15);
    r = table(ws, r, ['#', 'Title', 'Subreddit', 'Score', 'Comments', 'Author'],
      topPosts.map((p,i)=>[i+1,String(p['Title']||'').slice(0,60),p['Subreddit']||'',p._score,toNum(p['Num Comments']),p['Author']||'']),
      [{ col: 'D', color: C.ORANGE }]);

    if (authors.length > 0) {
      r = sec(ws, r, '👤 TOP AUTHORS BY POST COUNT', C.BLUE);
      r = table(ws, r, ['#', 'Author', 'Posts', '% of Total', 'Total Score'],
        authors.slice(0,10).map(([name,cnt],i) => {
          const authorScore = postsData.filter(p=>p['Author']===name).reduce((a,p)=>a+toNum(p['Score']),0);
          return [i+1, String(name||''), cnt, pct(cnt,postsData.length), authorScore];
        }),
        [{ col: 'C', color: C.SKY }]);
    }

    if (subreddits.length > 1) {
      r = sec(ws, r, '📋 SUBREDDITS IN RESULTS', C.TEAL);
      r = table(ws, r, ['#', 'Subreddit', 'Posts', '% of Total'],
        subreddits.slice(0,10).map(([name,cnt],i)=>[i+1,'r/'+String(name||''),cnt,pct(cnt,postsData.length)]),
        [{ col: 'C', color: C.SKY }]);
    }

    if (flairs.length > 0) {
      r = sec(ws, r, '🏷️  POST FLAIRS', C.PURPLE);
      r = table(ws, r, ['#', 'Flair', 'Count', '% of Posts'],
        flairs.slice(0,10).map(([f,c],i)=>[i+1,String(f),c,pct(c,postsData.length)]),
        [{ col: 'C', color: C.PURPLE }]);
    }

    r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
    r = insights(ws, r, [
      `${postsData.length.toLocaleString()} posts collected from ${[...new Set(postsData.map(p=>p['Subreddit']))].length} subreddit(s).`,
      `Top post: "${topPosts[0]?.['Title']?.slice(0,70)||'—'}" — ${fmt(topPosts[0]?._score||0)} score.`,
      `Most active author: "${authors[0]?.[0]||'—'}" posted ${authors[0]?.[1]||0} times (${pct(authors[0]?.[1]||0, postsData.length)}).`,
      `${videos} video post(s) and ${textPosts} text-only post(s). ${postsData.length-videos-textPosts} link posts.`,
      `Average upvote ratio: ${(postsData.reduce((a,p)=>a+parseFloat(p['Upvote Ratio']||0),0)/postsData.length*100).toFixed(1)}%.`,
      `${scores.filter(s=>s>1000).length} posts broke 1,000 score — high-engagement content tier.`,
    ]);

    // Distribution presets
    const scoreBuckets = [
      { label: 'Negative / 0',   count: scores.filter(s=>s<=0).length },
      { label: '1–10',           count: scores.filter(s=>s>=1&&s<=10).length },
      { label: '11–100',         count: scores.filter(s=>s>10&&s<=100).length },
      { label: '101–1K',         count: scores.filter(s=>s>100&&s<=1000).length },
      { label: '1K–10K',         count: scores.filter(s=>s>1000&&s<=10000).length },
      { label: '10K+',           count: scores.filter(s=>s>10000).length },
    ].map(b=>({...b, pct: pct(b.count, postsData.length)}));

    const commentBuckets = [
      { label: '0 comments',   count: comments.filter(c=>c===0).length },
      { label: '1–10',         count: comments.filter(c=>c>=1&&c<=10).length },
      { label: '11–100',       count: comments.filter(c=>c>10&&c<=100).length },
      { label: '101–500',      count: comments.filter(c=>c>100&&c<=500).length },
      { label: '500+',         count: comments.filter(c=>c>500).length },
    ].map(b=>({...b, pct: pct(b.count, postsData.length)}));

    makeTopSheet(wb, '📋 Top Posts', 'Top Posts by Score',
      ['Rank','Title','Subreddit','Score','Comments','Author'],
      topPosts.map((p,i)=>[i+1,String(p['Title']||'').slice(0,60),p['Subreddit']||'',p._score,toNum(p['Num Comments']),p['Author']||'']),
      'D', C.ORANGE);

    makeDistSheet(wb, '📋 Distribution', 'Reddit Post Distribution', [
      { heading: 'Score Distribution', buckets: scoreBuckets },
      { heading: 'Comment Count Distribution', buckets: commentBuckets },
      ...(flairs.length>0 ? [{ heading: 'Top Flairs', buckets: flairs.slice(0,8).map(([f,c])=>({label:String(f),count:c,pct:pct(c,postsData.length)})) }] : []),
    ]);
  }

  // ── Subreddit search analytics ────────────────────────────────────────────
  if (subsData.length > 0 && postsData.length === 0) {
    const subs     = subsData.filter(s=>s['Name']);
    const subCounts= subs.map(s=>toNum(s['Subscribers']));
    const actives  = subs.map(s=>toNum(s['Active Users']));

    r = sec(ws, r, '📈 KEY METRICS', C.ORANGE);
    r = kpiRow(ws, r, [
      { label: 'Subreddits Found', value: fmt(subs.length),              sub: 'matching keyword',               color: C.NAVY   },
      { label: 'Total Subscribers',value: fmt(subCounts.reduce((a,b)=>a+b,0)), sub: `avg ${fmt(Math.round(avg(subCounts)))}`, color: C.ORANGE },
      { label: 'Avg Active Users', value: fmt(Math.round(avg(actives))), sub: 'simultaneously online',           color: C.TEAL   },
      { label: 'Largest Sub',      value: 'r/'+(subs.sort((a,b)=>toNum(b['Subscribers'])-toNum(a['Subscribers']))[0]?.['Name']||'—'), sub: fmt(Math.max(...subCounts,0))+' subs', color: C.PURPLE },
    ]);
    r = gap(ws, r);

    const sorted = [...subs].sort((a,b)=>toNum(b['Subscribers'])-toNum(a['Subscribers']));
    r = sec(ws, r, '🏆 TOP SUBREDDITS BY SUBSCRIBERS', C.NAVY);
    r = table(ws, r, ['#','Name','Subscribers','Active','NSFW','Description'],
      sorted.slice(0,15).map((s,i)=>[i+1,'r/'+s['Name'],toNum(s['Subscribers']),toNum(s['Active Users']),String(s['NSFW']||''),String(s['Description']||'').slice(0,60)]),
      [{ col: 'C', color: C.ORANGE }]);

    r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
    r = insights(ws, r, [
      `${subs.length} subreddits found. Largest: r/${sorted[0]?.['Name']||'—'} with ${fmt(toNum(sorted[0]?.['Subscribers']||0))} subscribers.`,
      `${subs.filter(s=>String(s['NSFW']).toLowerCase()==='true').length} NSFW communities in results.`,
      `${subs.filter(s=>toNum(s['Subscribers'])>100000).length} subreddits have 100K+ subscribers.`,
      `${subs.filter(s=>toNum(s['Subscribers'])<1000).length} micro-communities with <1K subscribers.`,
    ]);

    const subTiers = [
      {label:'< 1K subs',    count:subCounts.filter(s=>s<1e3).length},
      {label:'1K–10K subs',  count:subCounts.filter(s=>s>=1e3&&s<1e4).length},
      {label:'10K–100K subs',count:subCounts.filter(s=>s>=1e4&&s<1e5).length},
      {label:'100K–1M subs', count:subCounts.filter(s=>s>=1e5&&s<1e6).length},
      {label:'1M+ subs',     count:subCounts.filter(s=>s>=1e6).length},
    ].map(b=>({...b,pct:pct(b.count,subs.length)}));

    makeTopSheet(wb,'📋 Top Subreddits','Top Subreddits by Subscribers',
      ['Rank','Name','Subscribers','Active Users','NSFW'],
      sorted.slice(0,50).map((s,i)=>[i+1,'r/'+s['Name'],toNum(s['Subscribers']),toNum(s['Active Users']),String(s['NSFW']||'')]),
      'C', C.ORANGE);
    makeDistSheet(wb,'📋 Distribution','Subreddit Distribution',[{heading:'Subscriber Tier Breakdown',buckets:subTiers}]);
  }

  // ── Comment analytics ──────────────────────────────────────────────────────
  if (commentsData.length > 0) {
    const scores    = commentsData.map(c=>toNum(c['Score']));
    const authors   = freq(commentsData.map(c=>c['Author']));
    const topLevels = commentsData.filter(c=>c['Is Top Level']==='yes').length;
    const replies   = commentsData.length - topLevels;
    const totalScore= scores.reduce((a,b)=>a+b,0);
    const postTitle = commentsData[0]?.['Post Title'] || '';

    r = sec(ws, r, '📈 KEY METRICS', C.ORANGE);
    r = kpiRow(ws, r, [
      { label: 'Total Comments',   value: fmt(commentsData.length), sub: `${authors.length} unique authors`, color: C.NAVY   },
      { label: 'Top-Level/Replies',value: `${topLevels}/${replies}`, sub: pct(replies,commentsData.length)+' replies', color: C.ORANGE },
      { label: 'Total Score',      value: fmt(totalScore),          sub: `avg ${fmt(Math.round(avg(scores)))}`, color: C.TEAL },
      { label: 'Max Score',        value: fmt(Math.max(...scores,0)), sub: 'highest rated comment', color: C.PURPLE },
    ]);
    r = gap(ws, r);

    if (postTitle) {
      r = sec(ws, r, 'ℹ️  POST CONTEXT', C.DK_GRAY);
      [['Post Title', postTitle],['Post URL', commentsData[0]?.['Post URL']||''],['Total Comments Scraped', commentsData.length]].forEach(([f,v],i)=>{
        ws.getRow(r+i).height=18;
        write(ws,r+i,1,f,{bg:C.BLUE,bold:true,size:9,color:C.WHITE,halign:'left',border:border('thin',C.NAVY)});
        merge(ws,r+i,2,r+i,COLS,String(v??''),{bg:i%2===0?C.ROW_A:C.ROW_B,size:10,color:C.DK_GRAY,halign:'left',border:border('thin')});
      });
      r+=5;
    }

    r = sec(ws, r, '🏆 TOP 15 COMMENTS BY SCORE', C.NAVY);
    const topComs = commentsData.map(c=>({...c,_score:toNum(c['Score'])})).sort((a,b)=>b._score-a._score).slice(0,15);
    r = table(ws, r, ['#','Author','Score','Depth','Comment Preview'],
      topComs.map((c,i)=>[i+1,c['Author']||'',c._score,c['Depth']||0,String(c['Body']||'').slice(0,80)]),
      [{ col: 'C', color: C.ORANGE }]);

    r = sec(ws, r, '👤 TOP COMMENTERS', C.BLUE);
    r = table(ws, r, ['#','Author','Comments','% of Total'],
      authors.slice(0,10).map(([name,cnt],i)=>[i+1,String(name||''),cnt,pct(cnt,commentsData.length)]),
      [{ col: 'C', color: C.SKY }]);

    r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
    r = insights(ws, r, [
      `${commentsData.length.toLocaleString()} comments collected from "${postTitle.slice(0,60)}".`,
      `${topLevels} top-level comments, ${replies} replies (${pct(replies,commentsData.length)} reply rate).`,
      `Most active commenter: "${authors[0]?.[0]||'—'}" posted ${authors[0]?.[1]||0} comments.`,
      `Average score per comment: ${fmt(Math.round(avg(scores)))}. Best comment score: ${fmt(Math.max(...scores,0))}.`,
      `${scores.filter(s=>s<0).length} downvoted comments (negative score).`,
    ]);

    makeTopSheet(wb,'📋 Top Commenters','Top Commenters by Count',
      ['Rank','Author','Comments','% of Total'],
      authors.slice(0,50).map(([name,cnt],i)=>[i+1,String(name||''),cnt,pct(cnt,commentsData.length)]),
      'C', C.ORANGE);

    const scoreBuckets=[
      {label:'Negative',count:scores.filter(s=>s<0).length},
      {label:'0–1',     count:scores.filter(s=>s>=0&&s<=1).length},
      {label:'2–10',    count:scores.filter(s=>s>1&&s<=10).length},
      {label:'11–100',  count:scores.filter(s=>s>10&&s<=100).length},
      {label:'100+',    count:scores.filter(s=>s>100).length},
    ].map(b=>({...b,pct:pct(b.count,commentsData.length)}));

    makeDistSheet(wb,'📋 Distribution','Comment Distribution',[
      {heading:'Score Distribution',buckets:scoreBuckets},
      {heading:'Top-Level vs Replies',buckets:[
        {label:'Top-Level',count:topLevels,pct:pct(topLevels,commentsData.length)},
        {label:'Replies',  count:replies,  pct:pct(replies,  commentsData.length)},
      ]},
    ]);
  }

  footer(ws, r + 2, `Reddit Dashboard · ${now()}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  7.  X (TWITTER) DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

export function addXDashboard(wb) {
  const tweets = readSheet(wb, 'Tweets');
  if (tweets.length === 0) return;
  const ts = now();

  const likes     = tweets.map(t => toNum(t['Likes']));
  const rts       = tweets.map(t => toNum(t['Retweets']));
  const replies   = tweets.map(t => toNum(t['Replies']));
  const authors   = freq(tweets.map(t => t['Author']));
  const langs     = freq(tweets.map(t => t['Language']).filter(Boolean));
  const isRT      = tweets.filter(t => t['Is Retweet'] === 'Yes').length;
  const isReply   = tweets.filter(t => t['Is Reply'] === 'Yes').length;
  const verified  = tweets.filter(t => t['Verified'] === 'Yes').length;
  const topByLikes= tweets.map(t=>({...t,_l:toNum(t['Likes'])})).sort((a,b)=>b._l-a._l).slice(0,15);
  const queries   = freq(tweets.map(t => t['Query / Context'] || t['contextQuery']).filter(Boolean));

  const ws = initSheet(wb, '📊 Dashboard', C.NAVY);
  setCols(ws, Array(COLS).fill(16));

  let r = hdr(ws, '✦ X / Twitter Analytics Dashboard', `${tweets.length.toLocaleString()} tweets collected`, ts);
  r = nav(ws, r, [
    { label:'📊 Dashboard', sheet:'📊 Dashboard' },
    { label:'🏆 Top Tweets', sheet:'📋 Top Tweets' },
    { label:'📊 Distribution', sheet:'📋 Distribution' },
    { label:'📄 Tweets', sheet:'Tweets' },
  ]);

  r = sec(ws, r, '📈 KEY METRICS', C.DK_GRAY);
  r = kpiRow(ws, r, [
    { label:'Total Tweets',    value:fmt(tweets.length),         sub:`${authors.length} unique authors`,          color:C.NAVY   },
    { label:'Total Likes',     value:fmt(likes.reduce((a,b)=>a+b,0)),  sub:`avg ${avg(likes).toFixed(1)}/tweet`,  color:C.BLUE   },
    { label:'Total Retweets',  value:fmt(rts.reduce((a,b)=>a+b,0)),    sub:`avg ${avg(rts).toFixed(1)}/tweet`,    color:C.TEAL   },
    { label:'Verified Authors',value:fmt(verified),              sub:pct(verified,tweets.length)+' of tweets',    color:C.PURPLE },
  ]);
  r = gap(ws, r);

  r = sec(ws, r, '🔥 TOP 15 TWEETS BY LIKES', C.NAVY);
  r = table(ws, r, ['#','Author','Likes','RT','Replies','Tweet Preview'],
    topByLikes.map((t,i)=>[i+1,'@'+(t['Author']||''),t._l,toNum(t['Retweets']),toNum(t['Replies']),String(t['Text']||'').slice(0,70)]),
    [{col:'C',color:C.AMBER}]);

  r = sec(ws, r, '👤 TOP AUTHORS', C.BLUE);
  r = table(ws, r, ['#','Author','Tweets','% of Total'],
    authors.slice(0,10).map(([n,c],i)=>[i+1,'@'+String(n||''),c,pct(c,tweets.length)]),
    [{col:'C',color:C.SKY}]);

  r = sec(ws, r, '🌐 CONTENT MIX', C.TEAL);
  [['Original tweets',tweets.length-isRT-isReply],['Retweets',isRT],['Replies',isReply],['Verified author tweets',verified]].forEach(([label,count],i)=>{
    ws.getRow(r+i).height=18;
    write(ws,r+i,1,label,{bg:i%2===0?C.ROW_A:C.ROW_B,size:10,color:C.DK_GRAY,halign:'left',border:border('thin')});
    write(ws,r+i,2,count,{bg:i%2===0?C.ROW_A:C.ROW_B,bold:true,size:10,color:C.BLUE,halign:'center',border:border('thin')});
    merge(ws,r+i,3,r+i,COLS,pct(count,tweets.length),{bg:i%2===0?C.ROW_A:C.ROW_B,size:9,color:C.MID_GRAY,halign:'left',border:border('thin')});
  });
  r+=6;

  r = sec(ws, r, '💡 INSIGHTS', C.DKGREEN);
  r = insights(ws, r, [
    `${tweets.length.toLocaleString()} tweets from ${authors.length} authors. ${verified} tweets from verified accounts (${pct(verified,tweets.length)}).`,
    `Total engagement: ${fmt(likes.reduce((a,b)=>a+b,0))} likes, ${fmt(rts.reduce((a,b)=>a+b,0))} retweets, ${fmt(replies.reduce((a,b)=>a+b,0))} replies.`,
    `Top tweet: "${topByLikes[0]?.['Text']?.slice(0,60)||'—'}" (${fmt(topByLikes[0]?._l||0)} likes).`,
    `Content mix: ${tweets.length-isRT-isReply} original, ${isRT} retweets, ${isReply} replies.`,
    `${langs.length > 0 ? `Top language: ${langs[0]?.[0]||'?'} (${pct(langs[0]?.[1]||0,tweets.length)})` : 'Language data unavailable'}.`,
  ]);
  footer(ws, r, `X Dashboard · ${tweets.length} tweets · ${ts}`);

  const likeTiers = [
    {label:'0',    count:likes.filter(l=>l===0).length},
    {label:'1–10', count:likes.filter(l=>l>=1&&l<=10).length},
    {label:'11–100',count:likes.filter(l=>l>10&&l<=100).length},
    {label:'101–1K',count:likes.filter(l=>l>100&&l<=1000).length},
    {label:'1K+',  count:likes.filter(l=>l>1000).length},
  ].map(b=>({...b,pct:pct(b.count,tweets.length)}));

  makeTopSheet(wb,'📋 Top Tweets','Top Tweets by Likes',
    ['Rank','Author','Likes','Retweets','Text Preview'],
    topByLikes.slice(0,50).map((t,i)=>[i+1,'@'+(t['Author']||''),t._l,toNum(t['Retweets']),String(t['Text']||'').slice(0,80)]),
    'C', C.BLUE);

  makeDistSheet(wb,'📋 Distribution','X Tweet Distribution',[
    {heading:'Likes Distribution', buckets:likeTiers},
    {heading:'Content Type Mix', buckets:[
      {label:'Original',count:tweets.length-isRT-isReply,pct:pct(tweets.length-isRT-isReply,tweets.length)},
      {label:'Retweets',count:isRT,pct:pct(isRT,tweets.length)},
      {label:'Replies', count:isReply,pct:pct(isReply,tweets.length)},
    ]},
    ...(langs.length>0?[{heading:'Top Languages',buckets:langs.slice(0,8).map(([l,c])=>({label:l,count:c,pct:pct(c,tweets.length)}))}]:[]),
  ]);
}
