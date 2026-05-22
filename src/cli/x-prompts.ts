/**
 * src/cli/x-prompts.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original x-prompts.mjs.
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

export async function askXMode() {
  const { mode } = await inquirer.prompt([{
    type:'list', name:'mode',
    message:'What would you like to do on X (Twitter)?',
    choices:[
      { name:'Search tweets  — tweets matching a keyword',       value:'search'   },
      { name:'User tweets    — all tweets from a @handle',       value:'user'     },
      { name:'Tweet replies  — all replies under a tweet URL',   value:'replies'  },
    ],
  }]);
  return mode;
}

export async function askXLogin() {
  const { wantLogin } = await inquirer.prompt([{
    type:'confirm', name:'wantLogin',
    message:'Log in to X before scraping? (More data available when logged in)',
    default: false,
  }]);
  return wantLogin;
}

export async function askXFilter() {
  const { filter } = await inquirer.prompt([{
    type:'list', name:'filter',
    message:'Search filter:',
    choices:[
      { name:'Latest (default)', value:null   },
      { name:'Top tweets',       value:'top'  },
      { name:'Live',             value:'live' },
    ],
  }]);
  return filter;
}

async function readLines(p) {
  const ext = p.trim().toLowerCase().split('.').pop();
  if (ext==='txt') return fs.readFileSync(p.trim(),'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if (ext==='xlsx') {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p.trim());
    const out=[]; wb.worksheets[0].eachRow(r=>{const v=String(r.getCell(1).value??'').trim();if(v)out.push(v);}); return out;
  }
  throw new Error('File must be .txt or .xlsx');
}

async function askInputMode(thing) {
  const {mode} = await inquirer.prompt([{type:'list',name:'mode',message:`Provide ${thing}:`,choices:[{name:'Single',value:'single'},{name:'File (.txt/.xlsx)',value:'file'}]}]);
  return mode;
}

export async function askXKeywords() {
  const mode = await askInputMode('keyword(s)');
  if (mode==='single') {
    const {k} = await inquirer.prompt([{type:'input',name:'k',message:'Keyword:',validate:v=>v.trim()?true:'Required'}]);
    return [k.trim()];
  }
  const {p} = await inquirer.prompt([{type:'input',name:'p',message:'File path:',validate:v=>fs.existsSync(v.trim())?true:'File not found'}]);
  const kws = await readLines(p); if(!kws.length) throw new Error('No keywords'); return kws;
}

export async function askXHandles() {
  const mode = await askInputMode('@handle(s)');
  if (mode==='single') {
    const {h} = await inquirer.prompt([{type:'input',name:'h',message:'@handle:',validate:v=>v.trim()?true:'Required'}]);
    return [h.trim()];
  }
  const {p} = await inquirer.prompt([{type:'input',name:'p',message:'File path:',validate:v=>fs.existsSync(v.trim())?true:'File not found'}]);
  const handles = await readLines(p); if(!handles.length) throw new Error('No handles'); return handles;
}

export async function askXTweetUrls() {
  const mode = await askInputMode('tweet URL(s)');
  if (mode==='single') {
    const {u} = await inquirer.prompt([{type:'input',name:'u',message:'Tweet URL:',validate:v=>(v.includes('x.com')||v.includes('twitter.com'))?true:'Invalid URL'}]);
    return [u.trim()];
  }
  const {p} = await inquirer.prompt([{type:'input',name:'p',message:'File path:',validate:v=>fs.existsSync(v.trim())?true:'File not found'}]);
  return readLines(p);
}

export async function askLimit(thing='results') {
  const {mode} = await inquirer.prompt([{type:'list',name:'mode',message:`How many ${thing}?`,choices:[{name:'First 50',value:'last5'},{name:'Specific number',value:'specific'},{name:'All available',value:'all'}]}]);
  if (mode==='specific') { const {c}=await inquirer.prompt([{type:'number',name:'c',message:'Number:',validate:v=>v>0?true:'Positive number'}]); return {mode,count:c}; }
  return { mode, count: mode==='last5'?50:null };
}
