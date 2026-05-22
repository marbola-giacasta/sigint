/**
 * src/cli/wizard.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * TypeScript conversion of the original wizard.mjs.
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
export async function askPlatform() {
  const { p } = await inquirer.prompt([{
    type:'list', name:'p',
    message:'Which platform would you like to scrape?',
    choices:[
      {name:'📸  Instagram — profiles, posts, stories, comments', value:'instagram'},
      {name:'▶️   YouTube  — search, channels, comments',          value:'youtube'},
      {name:'🟠  Reddit   — posts, subreddits, comments',         value:'reddit'},
      {name:'✦   X (Twitter) — tweets, profiles, threads',        value:'x'},
    ],
  }]);
  return p;
}
