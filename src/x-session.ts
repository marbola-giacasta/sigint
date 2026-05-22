/**
 * x-session.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original x-session.mjs.
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
import inquirer from 'inquirer';
import fs       from 'fs';
import { sleep } from './utils/sleep.js';
import { searchXPosts, scrapeXProfile, scrapeXThread, ensureXLogin, X_SEARCH_FILTERS } from './scraper/x/index.js';
import { appendXTweets, appendXProfileMeta, saveXWorkbook } from './output/x-excel.js';

async function readLines(thing) {
  const { mode } = await inquirer.prompt([{type:'list',name:'mode',message:`Provide ${thing}(s) as:`,choices:[{name:'Single',value:'single'},{name:'Multiple from file',value:'file'}]}]);
  if (mode==='single') {
    const { v } = await inquirer.prompt([{type:'input',name:'v',message:`Enter ${thing}:`,validate:v=>v.trim()?true:'Required'}]);
    return [v.trim()];
  }
  const { p } = await inquirer.prompt([{type:'input',name:'p',message:'Path (.txt or .xlsx):',validate:p=>fs.existsSync(p.trim())?true:'Not found'}]);
  const ext = p.trim().toLowerCase().split('.').pop();
  if (ext==='txt') return fs.readFileSync(p.trim(),'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const ExcelJS2 = (await import('exceljs')).default;
  const wb = new ExcelJS2.Workbook(); await wb.xlsx.readFile(p.trim());
  const out=[]; wb.worksheets[0].eachRow(r=>{const v=String(r.getCell(1).value??'').trim();if(v)out.push(v);}); return out;
}

async function askLimit(thing='tweets') {
  const {mode}=await inquirer.prompt([{type:'list',name:'mode',message:`How many ${thing}?`,choices:[{name:'First 50',value:'last5'},{name:'Specific',value:'specific'},{name:'All available',value:'all'}]}]);
  if(mode==='specific'){const{c}=await inquirer.prompt([{type:'number',name:'c',message:'Number:',validate:v=>v>0?true:'Positive'}]);return{mode,count:c};}
  return{mode,count:mode==='last5'?50:null};
}

export async function runXSession(page, isHeadless) {
  await ensureXLogin(page, isHeadless);

  const { mode } = await inquirer.prompt([{type:'list',name:'mode',message:'What would you like to do on X?',choices:[
    {name:'Search tweets  — keyword search',           value:'search'},
    {name:'Profile tweets — user profile scrape',      value:'profile'},
    {name:'Thread replies — replies to a tweet',       value:'thread'},
  ]}]);
  console.log('');

  const wb = new ExcelJS.Workbook();
  const lc = await askLimit();

  if (mode==='search') {
    const keywords = await readLines('keyword');
    const {filterKey}=await inquirer.prompt([{type:'list',name:'filterKey',message:'Filter:',choices:Object.entries(X_SEARCH_FILTERS).map(([k,v])=>({name:v.label,value:k}))}]);
    for (const kw of keywords) {
      try { appendXTweets(wb, await searchXPosts(page, kw, lc, filterKey)); } catch(e){console.error(`  ✖ "${kw}": ${e.message}`);}
      await sleep(2_000);
    }
    await saveXWorkbook(wb, keywords[0].replace(/\s+/g,'_').slice(0,40));
  } else if (mode==='profile') {
    const users = await readLines('username (@handle or URL)');
    for (const u of users) {
      try { const {meta,tweets}=await scrapeXProfile(page,u,lc); appendXProfileMeta(wb,meta); appendXTweets(wb,tweets,'Tweets'); } catch(e){console.error(`  ✖ "${u}": ${e.message}`);}
      await sleep(2_000);
    }
    await saveXWorkbook(wb, users[0].replace(/^@/,'').slice(0,40));
  } else {
    const urls = await readLines('tweet URL');
    for (const url of urls) {
      try { appendXTweets(wb, await scrapeXThread(page,url,lc), 'Thread Replies'); } catch(e){console.error(`  ✖ "${url}": ${e.message}`);}
      await sleep(2_000);
    }
    await saveXWorkbook(wb, 'thread');
  }

  console.log('\nX session complete.');
}
