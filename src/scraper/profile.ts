/**
 * TypeScript conversion — all logic identical to the working .mjs original.
 * Import paths use .js extension (TypeScript NodeNext requirement).
 * 'any' types used for API responses with complex/unknown shapes.
 */
import { CONFIG } from '../config.js';
import { sleep }  from '../utils/sleep.js';
import { safeGoto, dismissPopups } from '../browser/page.js';
import { createResponseCollector } from './interceptor.js';

function extractUser(json) {
  if(json?.data?.user) return json.data.user;
  const x=json?.data?.xdt_api__v1__users__web_profile_info__connection;
  return x?.user??null;
}

export async function scrapeProfileSummary(page,username){
  console.log(`  ┌─ Instagram Profile ─────────────────────────────`);
  console.log(`  │  Username : @${username}`);
  console.log(`  └───────────────────────────────────────────────────`);
  const _ig0 = Date.now();;
  const c=createResponseCollector(page,url=>url.includes('/web_profile_info/'),extractUser);
  await safeGoto(page,`${CONFIG.instagram.baseUrl}/${username}/`);
  await sleep(1_500); await dismissPopups(page); c.stop();
  let u=c.results[0]??null;
  if(!u) u=await page.evaluate(()=>{
    if(window._sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user) return window._sharedData.entry_data.ProfilePage[0].graphql.user;
    for(const s of document.querySelectorAll('script')){const t=s.textContent??'';if(t.includes('"biography"')&&t.includes('"follower_count"')){try{const m=t.match(/\{.*"biography".*"follower_count".*\}/s);if(m)return JSON.parse(m[0]);}catch{}}}
    return null;
  }).catch(()=>null);
  return { username:u?.username??username, fullName:u?.full_name??'', description:u?.biography??'', posts:String(u?.media_count??''), followers:String(u?.follower_count??''), following:String(u?.following_count??''), userId:String(u?.id??'') };
}
