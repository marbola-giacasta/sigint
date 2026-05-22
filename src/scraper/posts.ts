/**
 * TypeScript conversion — all logic identical to the working .mjs original.
 * Import paths use .js extension (TypeScript NodeNext requirement).
 * 'any' types used for API responses with complex/unknown shapes.
 */
import { CONFIG } from '../config.js';
import { sleep }  from '../utils/sleep.js';
import { applyLimit } from '../utils/limit.js';
import { safeGoto, dismissPopups } from '../browser/page.js';
import { createResponseCollector } from './interceptor.js';

export function normalisePost(raw) {
  if(!raw) return null;
  const item=raw.node??raw;
  const imageUrl=item.display_url??item.image_versions2?.candidates?.[0]?.url??item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url??'';
  const takenAt=item.taken_at_timestamp??item.taken_at;
  return { id:String(item.id??item.pk??''), shortcode:item.shortcode??item.code??'', imageUrl,
    timestamp:takenAt?new Date(takenAt*1_000).toISOString():'',
    description:item.edge_media_to_caption?.edges?.[0]?.node?.text??item.caption?.text??'',
    likes:String(item.edge_liked_by?.count??item.like_count??''),
    commentsCount:String(item.edge_media_to_comment?.count??item.comment_count??''), comments:[] };
}

export function normaliseComment(raw) {
  if(raw?.text) return { username:raw.user?.username??'', date:raw.created_at?new Date(raw.created_at*1_000).toISOString():'', text:raw.text };
  if(raw?.node?.text) return { username:raw.node.owner?.username??'', date:raw.node.created_at?new Date(raw.node.created_at*1_000).toISOString():'', text:raw.node.text };
  return null;
}

export async function scrapePostsFeed(page,username,userId,limitConfig){
  const seenIds=new Set(), posts=[];
  const c=createResponseCollector(page,
    url=>(userId&&url.includes(`/feed/user/${userId}`))||url.includes('/api/v1/feed/user/')||(url.includes('edge_owner_to_timeline_media')&&url.includes(username)),
    json=>{ if(Array.isArray((json as any)?.items)) return (json as any).items; const e=(json as any)?.data?.user?.edge_owner_to_timeline_media?.edges; if(Array.isArray(e)) return e; return null; });
  const cur=page.url();
  if(!cur.includes(`instagram.com/${username}`)) { await safeGoto(page,`${CONFIG.instagram.baseUrl}/${username}/`); await sleep(1_500); await dismissPopups(page); }
  const target=limitConfig.mode==='all'?9_999:(limitConfig.count??5);
  let noNew=0;
  while(posts.length<target&&noNew<4){
    const before=posts.length;
    for(const batch of c.results) for(const raw of (Array.isArray(batch)?batch:[batch])){const p=normalisePost(raw);if(p?.id&&!seenIds.has(p.id)){seenIds.add(p.id);posts.push(p);}}
    noNew=posts.length===before?noNew+1:0;
    if(posts.length>=target) break;
    await page.evaluate(()=>window.scrollBy(0,window.innerHeight*2)).catch(()=>{});
    await sleep(CONFIG.instagram.scrollDelayBase+Math.random()*500);
  }
  c.stop();
  if(posts.length===0){
    const links=await page.evaluate(()=>[...new Set(Array.from(document.querySelectorAll('a[href*="/p/"]')).map(a=>(a as any).href))]).catch(()=>[]);
    for(const link of links.slice(0,target)){const sc=link.match(/\/p\/([^/]+)\//)?.[1];if(sc&&!seenIds.has(sc)){seenIds.add(sc);posts.push({id:sc,shortcode:sc,imageUrl:'',timestamp:'',description:'',likes:'',commentsCount:'',comments:[],_postUrl:link});}}
  }
  return applyLimit(posts,limitConfig).map((p,i)=>({...p,index:i}));
}

export async function scrapePostDetails(page,post){
  if(!post.shortcode&&!post._postUrl) return post;
  const url=post._postUrl??`${CONFIG.instagram.baseUrl}/p/${post.shortcode}/`;
  let {imageUrl,description,likes,commentsCount}=post; let comments=[];
  const c=createResponseCollector(page,u=>u.includes('/media/')&&u.includes('comment'),
    json=>{ if(Array.isArray((json as any)?.comments)) return (json as any).comments; const e=(json as any)?.data?.xdt_api__v1__media__comments__connection?.edges; if(Array.isArray(e)) return e; return null; });
  try {
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60_000}); await sleep(2_000); await dismissPopups(page);
    if(!imageUrl) imageUrl=await page.evaluate(()=>(document.querySelector('article div[role="presentation"] img') as any??document.querySelector('article img') as any??document.querySelector('img[style*="object-fit"]') as any)?.src??'').catch(()=>'');
    await sleep(1_500);
    for(const batch of c.results) for(const raw of (Array.isArray(batch)?batch:[batch])){const cm=normaliseComment(raw);if(cm)comments.push(cm);}
    if(comments.length===0) comments=await page.evaluate(()=>{const out=[];document.querySelectorAll('ul > li > div').forEach(li=>{const a=li.querySelector('a[href*="/"]');const spans=li.querySelectorAll('span');if(a&&spans.length>0)out.push({username:a.textContent?.trim()??'',date:'',text:spans[spans.length-1].textContent?.trim()??''});});return out.slice(0,50);}).catch(()=>[]);
    if(!description||!likes){const m=await page.evaluate(()=>({description:(document.querySelector('h1')?.textContent??document.querySelector('span[dir="auto"]')?.textContent??'').trim(),likes:(document.querySelector('section span[class]')?.textContent??'').replace(/[^\d,]/g,'')})).catch(()=>({}));if(!description)description=m.description??'';if(!likes)likes=m.likes??'';}
  } catch(err){console.log(`    ⚠ Post "${post.shortcode}": ${err.message}`);}
  c.stop();
  return {...post,imageUrl,description,likes,commentsCount,comments};
}
