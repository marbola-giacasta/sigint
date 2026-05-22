/**
 * src/cli/prompts.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original prompts.mjs.
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

export async function askProfileMode() {
  const { mode } = await inquirer.prompt([{
    type:    'list', name: 'mode',
    message: 'Fetch a single profile or a batch from Excel?',
    choices: [
      { name: 'Single profile (enter @username)',         value: 'single'   },
      { name: 'Multiple profiles from .xlsx (column A)', value: 'multiple' },
    ],
  }]);
  return mode;
}

export async function getProfilesSingle() {
  const { username } = await inquirer.prompt([{
    type: 'input', name: 'username',
    message:  'Enter Instagram username (without @):',
    validate: v => v.trim() ? true : 'Please enter a username',
  }]);
  return [username.trim().replace(/^@/, '')];
}

export async function getProfilesFromExcel() {
  const { filePath } = await inquirer.prompt([{
    type: 'input', name: 'filePath',
    message: 'Path to .xlsx file (usernames in column A):',
    validate: p => {
      if (!p.trim())                                 return 'Please enter a path';
      if (!fs.existsSync(p.trim()))                  return 'File not found';
      if (!p.toLowerCase().endsWith('.xlsx'))        return 'Must be a .xlsx file';
      return true;
    },
  }]);
  const wb    = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath.trim());
  const sheet = wb.worksheets[0];
  const profiles = [];
  sheet.eachRow(row => {
    const v = String(row.getCell(1).value ?? '').trim().replace(/^@/, '');
    if (v) profiles.push(v);
  });
  if (!profiles.length) throw new Error('No usernames found in column A.');
  console.log(`Loaded ${profiles.length} profile(s).\n`);
  return profiles;
}

export async function askPostsLimit() {
  const { mode } = await inquirer.prompt([{
    type: 'list', name: 'mode',
    message: 'How many posts / stories to collect per profile?',
    choices: [
      { name: 'Last 5 published',                         value: 'last5'    },
      { name: 'Specific number (in order of appearance)', value: 'specific' },
      { name: 'All available',                            value: 'all'      },
    ],
  }]);
  if (mode === 'specific') {
    const { count } = await inquirer.prompt([{ type: 'number', name: 'count', message: 'How many?', validate: v => v > 0 ? true : 'Enter a positive number' }]);
    return { mode, count };
  }
  return { mode, count: mode === 'last5' ? 5 : null };
}
