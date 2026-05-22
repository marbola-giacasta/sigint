/**
 * src/cli/reddit-prompts.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original reddit-prompts.mjs.
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
import inquirer from 'inquirer';
import fs       from 'fs';
import ExcelJS  from 'exceljs';

export async function askRedditMode() {
  const { mode } = await inquirer.prompt([{
    type: 'list', name: 'mode',
    message: 'What would you like to do on Reddit?',
    choices: [
      { name: 'Search posts       — posts matching a keyword across all of Reddit', value: 'search-posts' },
      { name: 'Search subreddits  — find subreddits matching a keyword',           value: 'search-subs'  },
      { name: 'Subreddit posts    — scrape posts from a specific subreddit',        value: 'subreddit'    },
      { name: 'Post comments      — fetch all comments from one or more post URLs', value: 'comments'     },
    ],
  }]);
  return mode;
}

export async function askRedditSortTime() {
  const { sort } = await inquirer.prompt([{
    type: 'list', name: 'sort',
    message: 'Sort posts by:',
    choices: [
      { name: 'Relevance (search default)', value: 'relevance' },
      { name: 'Hot',                        value: 'hot'        },
      { name: 'Top',                        value: 'top'        },
      { name: 'New',                        value: 'new'        },
      { name: 'Most comments',              value: 'comments'   },
    ],
  }]);

  let time = 'all';
  if (sort === 'top' || sort === 'relevance') {
    const { t } = await inquirer.prompt([{
      type: 'list', name: 't',
      message: 'Time period:',
      choices: [
        { name: 'All time', value: 'all'   },
        { name: 'This year',value: 'year'  },
        { name: 'This month',value:'month' },
        { name: 'This week', value:'week'  },
        { name: 'Today',     value:'day'   },
        { name: 'Last hour', value:'hour'  },
      ],
    }]);
    time = t;
  }

  return { sort, time };
}

export async function askSubredditSort() {
  const { sort } = await inquirer.prompt([{
    type: 'list', name: 'sort',
    message: 'Sort subreddit feed by:',
    choices: [
      { name: 'Hot (default)',      value: 'hot'           },
      { name: 'New',                value: 'new'           },
      { name: 'Top (all time)',     value: 'top'           },
      { name: 'Top (this month)',   value: 'top-month'     },
      { name: 'Top (this week)',    value: 'top-week'      },
      { name: 'Rising',             value: 'rising'        },
      { name: 'Controversial',      value: 'controversial' },
    ],
  }]);

  const [sortKey, timeSuffix] = sort.split('-');
  return { sort: sortKey, time: timeSuffix || 'all' };
}

async function readLines(filePath) {
  const ext = filePath.trim().toLowerCase().split('.').pop();
  if (ext === 'txt') return fs.readFileSync(filePath.trim(),'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if (ext === 'xlsx') {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(filePath.trim());
    const out=[]; wb.worksheets[0].eachRow(r=>{const v=String(r.getCell(1).value??'').trim();if(v)out.push(v);}); return out;
  }
  throw new Error('File must be .txt or .xlsx');
}

function validate(p) {
  if (!p.trim()) return 'Required';
  if (!fs.existsSync(p.trim())) return 'File not found';
  return true;
}

export async function askPostUrls() {
  const { mode } = await inquirer.prompt([{ type:'list', name:'mode', message:'Provide post URL(s) as:', choices:[{name:'Single',value:'single'},{name:'File (.txt/.xlsx)',value:'file'}] }]);
  if (mode === 'single') {
    const { u } = await inquirer.prompt([{ type:'input', name:'u', message:'Reddit post URL:', validate: v=>v.includes('reddit.com')?true:'Invalid Reddit URL' }]);
    return [u.trim()];
  }
  const { p } = await inquirer.prompt([{ type:'input', name:'p', message:'Path to file:', validate }]);
  const urls = await readLines(p); if (!urls.length) throw new Error('No URLs found'); console.log(`Loaded ${urls.length} URL(s).\n`); return urls;
}

export async function askKeywords() {
  const { mode } = await inquirer.prompt([{ type:'list', name:'mode', message:'Provide keyword(s) as:', choices:[{name:'Single',value:'single'},{name:'File (.txt/.xlsx)',value:'file'}] }]);
  if (mode === 'single') {
    const { k } = await inquirer.prompt([{ type:'input', name:'k', message:'Keyword:', validate: v=>v.trim()?true:'Required' }]);
    return [k.trim()];
  }
  const { p } = await inquirer.prompt([{ type:'input', name:'p', message:'Path to file:', validate }]);
  const kws = await readLines(p); if (!kws.length) throw new Error('No keywords found'); console.log(`Loaded ${kws.length} keyword(s).\n`); return kws;
}

export async function askSubredditInput() {
  const { mode } = await inquirer.prompt([{ type:'list', name:'mode', message:'Provide subreddit(s) as:', choices:[{name:'Single',value:'single'},{name:'File (.txt/.xlsx)',value:'file'}] }]);
  if (mode === 'single') {
    const { s } = await inquirer.prompt([{ type:'input', name:'s', message:'Subreddit name or URL (e.g. r/technology):', validate: v=>v.trim()?true:'Required' }]);
    return [s.trim()];
  }
  const { p } = await inquirer.prompt([{ type:'input', name:'p', message:'Path to file:', validate }]);
  const subs = await readLines(p); if (!subs.length) throw new Error('No subreddits found'); console.log(`Loaded ${subs.length} subreddit(s).\n`); return subs;
}

export async function askLimit(thing = 'results') {
  const { mode } = await inquirer.prompt([{ type:'list', name:'mode', message:`How many ${thing} to collect?`,
    choices:[{name:'First 25',value:'last5'},{name:'Specific number',value:'specific'},{name:'All available',value:'all'}] }]);
  if (mode==='specific') { const {c}=await inquirer.prompt([{type:'number',name:'c',message:'Number:',validate:v=>v>0?true:'Positive number required'}]); return {mode,count:c}; }
  return { mode, count: mode==='last5'?25:null };
}
