/**
 * TypeScript conversion — all logic identical to the working .mjs original.
 * Import paths use .js extension (TypeScript NodeNext requirement).
 * 'any' types used for API responses with complex/unknown shapes.
 */
/**
 * src/scraper/reddit/post-comments.mjs
 * Fetches all comments from a Reddit post URL.
 * Handles nested replies up to 3 levels deep.
 */

import { applyLimit }  from '../../utils/limit.js';
import { redditFetch, ensureRedditSession, normalisePost, normaliseComment } from './api.js';

function parsePostUrl(input) {
  // Normalise to https://www.reddit.com/r/.../comments/...
  const t = input.trim().replace(/\/$/, '');
  if (!t.includes('reddit.com')) return null;
  return t.replace('http://', 'https://').replace('https://old.reddit.com', 'https://www.reddit.com');
}

function flattenCommentTree(tree, postTitle, postUrl, depth = 0, out = []) {
  for (const item of (tree ?? [])) {
    if (!item?.data) continue;
    if (item.kind === 'more') continue;  // "load more" placeholders
    const c = normaliseComment(item.data, postTitle, postUrl, depth);
    if (c) out.push(c);
    // Recurse into replies
    const replies = item.data.replies?.data?.children;
    if (Array.isArray(replies) && depth < 5) {
      flattenCommentTree(replies, postTitle, postUrl, depth + 1, out);
    }
  }
  return out;
}

export async function scrapePostComments(page, postUrl, limitConfig) {
  await ensureRedditSession(page);
  const normUrl = parsePostUrl(postUrl);
  if (!normUrl) throw new Error(`Invalid Reddit URL: ${postUrl}`);

  console.log(`  → Reddit comments: ${normUrl}`);

  const jsonUrl = `${normUrl}.json?limit=500&depth=5`;
  const json    = await redditFetch(page, jsonUrl);

  if (!Array.isArray(json) || json.length < 2) {
    throw new Error('Unexpected response shape from Reddit post API');
  }

  // json[0] = post listing, json[1] = comment tree
  const postData = json[0]?.data?.children?.[0]?.data ?? {};
  const post     = normalisePost(postData);
  const postTitle = post?.title ?? '';

  const commentTree = json[1]?.data?.children ?? [];
  const allComments = flattenCommentTree(commentTree, postTitle, normUrl);

  const limited = applyLimit(allComments, limitConfig);
  console.log(`  ✓ Collected ${limited.length} comment(s) from "${postTitle.slice(0,60)}"`);
  return { post, comments: limited };
}
