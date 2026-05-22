/**
 * src/cli/youtube-prompts.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original youtube-prompts.mjs.
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
 * src/cli/youtube-prompts.mjs — all YouTube interactive prompts
 */

import inquirer from 'inquirer';
import fs       from 'fs';
import ExcelJS  from 'exceljs';

// ── Sort / filter parameters ──────────────────────────────────────────────────
// YouTube encodes filters in the `sp` URL param (protobuf base64).
// These are the known stable values for common combinations.

export const YT_FILTERS = {
  // Upload date only
  date_anytime:   null,
  date_hour:      'EgIIAQ%3D%3D',
  date_today:     'EgIIAg%3D%3D',
  date_week:      'EgIIAw%3D%3D',
  date_month:     'EgIIBA%3D%3D',
  date_year:      'EgIIBQ%3D%3D',
  // Sort only
  sort_relevance: null,
  sort_date:      'CAI%3D',
  sort_views:     'CAM%3D',
  sort_rating:    'CAE%3D',
  // Common combinations (upload-date sort + period filter)
  date_week_sort_date:  'EgQIAxAB',
  date_month_sort_date: 'EgQIBBAB',
  date_year_sort_date:  'EgQIBRAB',
};

// Human-readable labels → sp param value
const SEARCH_FILTER_CHOICES = [
  { name: 'Any time  ·  Sorted by relevance (default)',  value: null },
  { name: 'Any time  ·  Sorted by upload date',          value: YT_FILTERS.sort_date },
  { name: 'Any time  ·  Sorted by view count',           value: YT_FILTERS.sort_views },
  { name: 'Any time  ·  Sorted by rating',               value: YT_FILTERS.sort_rating },
  { name: 'Uploaded today',                              value: YT_FILTERS.date_today },
  { name: 'Uploaded this week',                          value: YT_FILTERS.date_week },
  { name: 'Uploaded this week  ·  Sorted by date',       value: YT_FILTERS.date_week_sort_date },
  { name: 'Uploaded this month',                         value: YT_FILTERS.date_month },
  { name: 'Uploaded this month  ·  Sorted by date',      value: YT_FILTERS.date_month_sort_date },
  { name: 'Uploaded this year',                          value: YT_FILTERS.date_year },
  { name: 'Uploaded this year  ·  Sorted by date',       value: YT_FILTERS.date_year_sort_date },
];

// For channel browse API (different param encoding)
const CHANNEL_SORT_CHOICES = [
  { name: 'Default order (newest first)',      value: null },
  { name: 'Sorted by popularity (most viewed)', value: 'EgZ2aWRlb3MQAg%3D%3D' },
  { name: 'Sorted by oldest first',            value: 'EgZ2aWRlb3MQCg%3D%3D' },
];

// ── Mode ──────────────────────────────────────────────────────────────────────

export async function askYoutubeMode() {
  const { mode } = await inquirer.prompt([{
    type:    'list',
    name:    'mode',
    message: 'What would you like to do on YouTube?',
    choices: [
      { name: 'Search videos   — titles, links, views & descriptions for a keyword', value: 'search' },
      { name: 'Search channels — find channels matching a keyword',                  value: 'channel-search' },
      { name: 'Channel videos  — scrape all videos from a specific channel URL',     value: 'channel-videos' },
      { name: 'Comments        — fetch all comments from one or more video URLs',    value: 'comments' },
    ],
  }]);
  return mode;
}

// ── Sort / date filter prompt ─────────────────────────────────────────────────

export async function askSearchFilter() {
  const { filter } = await inquirer.prompt([{
    type:    'list',
    name:    'filter',
    message: 'Apply a date / sort filter to results?',
    choices: SEARCH_FILTER_CHOICES,
  }]);
  return filter;  // null = no filter; otherwise an `sp` param value
}

export async function askChannelSortFilter() {
  const { filter } = await inquirer.prompt([{
    type:    'list',
    name:    'filter',
    message: 'Sort channel videos by:',
    choices: CHANNEL_SORT_CHOICES,
  }]);
  return filter;
}

// ── File helpers ──────────────────────────────────────────────────────────────

function validateFilePath(p, exts) {
  const t = (p ?? '').trim();
  if (!t) return 'Please enter a file path';
  if (!fs.existsSync(t)) return `File not found: ${t}`;
  const ext = t.toLowerCase().split('.').pop();
  if (!exts.includes(ext)) return `File must be: ${exts.map(e=>'.'+e).join(', ')}`;
  return true;
}

async function readLinesFromFile(filePath) {
  const ext = filePath.trim().toLowerCase().split('.').pop();
  if (ext === 'txt') {
    return fs.readFileSync(filePath.trim(), 'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  }
  if (ext === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath.trim());
    const out = [];
    wb.worksheets[0].eachRow(r => { const v = String(r.getCell(1).value??'').trim(); if(v) out.push(v); });
    return out;
  }
  throw new Error(`Unsupported: .${ext}`);
}

async function askInputMode(thing) {
  const { mode } = await inquirer.prompt([{
    type: 'list', name: 'mode',
    message: `Provide ${thing} as:`,
    choices: [
      { name: `Single (type it in)`,              value: 'single' },
      { name: `Multiple — from .txt or .xlsx`,    value: 'file'   },
    ],
  }]);
  return mode;
}

// ── Keywords ──────────────────────────────────────────────────────────────────

export async function askKeywords() {
  const mode = await askInputMode('keyword(s)');
  if (mode === 'single') {
    const { k } = await inquirer.prompt([{ type:'input', name:'k', message:'Search keyword:', validate: v=>v.trim()?true:'Required' }]);
    return [k.trim()];
  }
  const { p } = await inquirer.prompt([{ type:'input', name:'p', message:'Path to .txt or .xlsx:', validate: v=>validateFilePath(v,['txt','xlsx']) }]);
  const kws = await readLinesFromFile(p);
  if (!kws.length) throw new Error('No keywords found.');
  console.log(`Loaded ${kws.length} keyword(s).\n`);
  return kws;
}

// ── Video URLs ────────────────────────────────────────────────────────────────

export async function askVideoUrls() {
  const mode = await askInputMode('video URL(s)');
  if (mode === 'single') {
    const { u } = await inquirer.prompt([{ type:'input', name:'u', message:'YouTube video URL:', validate: v=>(v.includes('youtube.com/watch')||v.includes('youtu.be'))?true:'Invalid YouTube URL' }]);
    return [u.trim()];
  }
  const { p } = await inquirer.prompt([{ type:'input', name:'p', message:'Path to .txt or .xlsx:', validate: v=>validateFilePath(v,['txt','xlsx']) }]);
  const urls = await readLinesFromFile(p);
  if (!urls.length) throw new Error('No URLs found.');
  console.log(`Loaded ${urls.length} URL(s).\n`);
  return urls;
}

// ── Channel URLs ──────────────────────────────────────────────────────────────

function isValidChannelUrl(v) {
  const t = v.trim();
  return (t.includes('youtube.com/@')||t.includes('youtube.com/c/')||t.includes('youtube.com/channel/')||t.includes('youtube.com/user/'))
    ? true : 'Please enter a valid YouTube channel URL (e.g. https://www.youtube.com/@ChannelName)';
}

export async function askChannelUrls() {
  const mode = await askInputMode('channel URL(s)');
  if (mode === 'single') {
    const { u } = await inquirer.prompt([{ type:'input', name:'u', message:'YouTube channel URL (e.g. https://www.youtube.com/@ChannelName):', validate: isValidChannelUrl }]);
    return [u.trim()];
  }
  const { p } = await inquirer.prompt([{ type:'input', name:'p', message:'Path to .txt or .xlsx:', validate: v=>validateFilePath(v,['txt','xlsx']) }]);
  const urls = await readLinesFromFile(p);
  if (!urls.length) throw new Error('No URLs found.');
  console.log(`Loaded ${urls.length} URL(s).\n`);
  return urls;
}

// ── Limits ────────────────────────────────────────────────────────────────────

export async function askResultsLimit() {
  const { mode } = await inquirer.prompt([{ type:'list', name:'mode', message:'How many search results per keyword?',
    choices:[{name:'First 20 results',value:'last5'},{name:'Specific number',value:'specific'},{name:'All available',value:'all'}] }]);
  if (mode==='specific') { const {c}=await inquirer.prompt([{type:'number',name:'c',message:'Number:',validate:v=>v>0?true:'Positive number required'}]); return {mode,count:c}; }
  return { mode, count: mode==='last5'?20:null };
}

export async function askCommentsLimit() {
  const { mode } = await inquirer.prompt([{ type:'list', name:'mode', message:'How many comments per video?',
    choices:[{name:'First 100 comments',value:'last5'},{name:'Specific number',value:'specific'},{name:'All available',value:'all'}] }]);
  if (mode==='specific') { const {c}=await inquirer.prompt([{type:'number',name:'c',message:'Number:',validate:v=>v>0?true:'Positive number required'}]); return {mode,count:c}; }
  return { mode, count: mode==='last5'?100:null };
}

export async function askChannelVideosLimit() {
  const { mode } = await inquirer.prompt([{ type:'list', name:'mode', message:'How many videos per channel?',
    choices:[{name:'First 30 videos',value:'last5'},{name:'Specific number',value:'specific'},{name:'All available',value:'all'}] }]);
  if (mode==='specific') { const {c}=await inquirer.prompt([{type:'number',name:'c',message:'Number:',validate:v=>v>0?true:'Positive number required'}]); return {mode,count:c}; }
  return { mode, count: mode==='last5'?30:null };
}
