/**
 * src/displayServer.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Display server — runs on port 3002 alongside the admin UI (port 3001).
 * Serves the public-facing intelligence feed display page.
 *
 * ARCHITECTURE:
 *   Admin (3001) receives a POST /api/publish from the UI
 *   → normalises the job results into { author, content, date } rows
 *   → stores them in publishedData (shared in-memory module variable)
 *   → notifies all SSE clients on port 3002
 *
 *   Display page (3002) serves display.html and a /stream SSE endpoint
 *   that pushes updates to every open browser tab watching the feed.
 *
 * CALLED FROM: uiServer.ts → startDisplayServer()
 */

import express     from 'express';
import path        from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const DISPLAY_PORT = 3002;

// ─────────────────────────────────────────────────────────────────────────────
// Shared published data store
// ─────────────────────────────────────────────────────────────────────────────

/** One display row: three columns shown in the feed */
export interface DisplayRow {
  author:  string;   // left column
  content: string;   // middle column (marquee)
  date:    string;   // right column
}

/** One platform section in the feed */
export interface DisplaySection {
  platform:    string;
  mode:        string;
  description: string;
  rows:        DisplayRow[];
  pushedAt:    number;  // Unix timestamp ms
}

/** The full published dataset served to the display page */
let publishedData: { sections: DisplaySection[]; lastUpdate: number } = {
  sections:   [],
  lastUpdate: 0,
};

/** Active SSE response streams (browser tabs watching the display) */
const sseClients = new Set<express.Response>();

/** Broadcast the current publishedData to all connected SSE clients */
function broadcastUpdate(): void {
  const msg = `data: ${JSON.stringify(publishedData)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

/** Called by uiServer.ts when admin clicks "Publish to Display" */
export function publishToDisplay(sections: DisplaySection[]): void {
  // Merge: replace sections for the same platform/mode, keep others
  for (const incoming of sections) {
    const idx = publishedData.sections.findIndex(
      s => s.platform === incoming.platform && s.mode === incoming.mode,
    );
    if (idx >= 0) {
      publishedData.sections[idx] = incoming; // replace existing
    } else {
      publishedData.sections.push(incoming);  // add new
    }
  }

  // Sort sections: YouTube → Reddit → Instagram → X
  const ORDER = ['youtube', 'reddit', 'instagram', 'x'];
  publishedData.sections.sort(
    (a, b) => (ORDER.indexOf(a.platform) + 1 || 99) - (ORDER.indexOf(b.platform) + 1 || 99),
  );

  publishedData.lastUpdate = Date.now();
  broadcastUpdate();
}

// ─────────────────────────────────────────────────────────────────────────────
// Result normalisation: any scrape mode → { author, content, date } rows
// ─────────────────────────────────────────────────────────────────────────────

/** Normalises a single raw result object into a display row */
function normaliseRow(item: any, platform: string, mode: string): DisplayRow | null {
  if (!item) return null;

  let author  = '';
  let content = '';
  let date    = '';

  if (platform === 'youtube') {
    if (mode === 'search') {
      author  = item.channelName || '';
      content = [item.title, item.descriptionSnippet].filter(Boolean).join(' — ');
      date    = item.uploadDate || '';
    } else if (mode === 'channel-videos') {
      author  = item.channelName || '';
      content = item.title || '';
      date    = item.uploadDate || '';
    } else if (mode === 'channel-search') {
      author  = item.channelName || '';
      content = [item.description, item.subscribers ? `${item.subscribers} subs` : ''].filter(Boolean).join(' · ');
      date    = '';
    } else if (mode === 'comments') {
      author  = item.author || '';
      content = item.text || '';
      date    = item.date || '';
    }

  } else if (platform === 'reddit') {
    if (mode === 'search-posts' || mode === 'subreddit') {
      author  = [`r/${item.subreddit}`, item.author ? `u/${item.author}` : ''].filter(Boolean).join(' · ');
      content = item.title || '';
      date    = item.createdUtc || '';
    } else if (mode === 'post-comments') {
      author  = item.author ? `u/${item.author}` : '';
      content = item.body || '';
      date    = item.createdUtc || '';
    } else if (mode === 'search-subs') {
      author  = item.name ? `r/${item.name}` : '';
      content = [item.title, item.description].filter(Boolean).join(' — ');
      date    = item.created || '';
    }

  } else if (platform === 'instagram') {
    // Profile result contains nested posts/stories
    if (item.posts) {
      return null; // handled separately below
    }
    author  = item.profile || item.username || '';
    content = item.description || item.text || '';
    date    = item.timestamp || '';

  } else if (platform === 'x') {
    author  = item.author ? `@${item.author}` : '';
    content = item.text || '';
    date    = item.timestamp || '';
  }

  if (!content && !author) return null;

  return {
    author:  author.slice(0, 60).trim(),
    content: content.replace(/\s+/g, ' ').trim(),
    date:    date ? String(date).slice(0, 19) : '',
  };
}

/**
 * Converts raw job results into DisplaySection(s), limited to `count` rows.
 * Instagram profile results need special handling (nested posts array).
 */
export function normaliseResults(
  platform: string,
  mode:     string,
  results:  any[],
  count:    number,
): DisplaySection[] {
  const sections: DisplaySection[] = [];

  // Instagram: results are { username, summary, posts, stories }
  if (platform === 'instagram') {
    const rows: DisplayRow[] = [];
    for (const profile of results) {
      const posts = (profile.posts || []).slice(0, count);
      for (const post of posts) {
        const row = normaliseRow(
          { ...post, username: profile.username || post.profile },
          'instagram', 'profile',
        );
        if (row) rows.push(row);
      }
    }
    sections.push({
      platform:    'instagram',
      mode:        'profile',
      description: `${rows.length} items from ${results.length} profile(s)`,
      rows:        rows.slice(0, count),
      pushedAt:    Date.now(),
    });
    return sections;
  }

  const rows: DisplayRow[] = [];
  for (const item of results) {
    const row = normaliseRow(item, platform, mode);
    if (row) rows.push(row);
    if (rows.length >= count) break;
  }

  const modeLabel: Record<string, string> = {
    'search':        'Video Search',
    'channel-search':'Channel Search',
    'channel-videos':'Channel Videos',
    'comments':      'Video Comments',
    'search-posts':  'Post Search',
    'search-subs':   'Subreddit Search',
    'subreddit':     'Subreddit Posts',
    'post-comments': 'Post Comments',
    'profile':       'Profile',
    'thread':        'Thread',
  };

  sections.push({
    platform,
    mode,
    description: modeLabel[mode] || mode,
    rows,
    pushedAt:    Date.now(),
  });

  return sections;
}

// ─────────────────────────────────────────────────────────────────────────────
// Express app on port 3002
// ─────────────────────────────────────────────────────────────────────────────

const display = express();

/** CORS header — lets the display page (on any origin) fetch /data and /stream */
display.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

/** Serve the display HTML page */
display.get('/', (_req, res: any) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'display.html'));
});

/** JSON data endpoint — for initial load and polling fallback */
display.get('/data', (_req, res) => {
  res.json(publishedData);
});

/** SSE stream — push updates to all open display tabs */
display.get('/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send current state immediately so the new tab is up-to-date
  res.write(`data: ${JSON.stringify(publishedData)}\n\n`);

  sseClients.add(res as any);
  req.on('close', () => sseClients.delete(res as any));
});

/** Start the display server */
export function startDisplayServer(origLog: (...args: any[]) => void): void {
  display.listen(DISPLAY_PORT, () => {
    origLog(`  ║  Display Feed  →  http://localhost:${DISPLAY_PORT}           ║`);
  });
}
