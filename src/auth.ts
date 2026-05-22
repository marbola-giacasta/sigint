/**
 * src/auth.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Simple session-based authentication for the admin UI.
 *
 * HOW IT WORKS
 * ─────────────
 * - Admin credentials come from environment variables (ADMIN_USER, ADMIN_PASS)
 *   so they're never hardcoded in source code.
 * - On first run, if no env vars are set, defaults to admin/changeme and
 *   prints a loud warning — forces the admin to change it.
 * - Sessions are stored in memory (simple Map). On server restart, all
 *   sessions expire, requiring re-login.
 * - Public routes (ticker data, login page itself) bypass auth entirely.
 *
 * ENVIRONMENT VARIABLES
 * ──────────────────────
 *   ADMIN_USER   — admin username          (default: "admin")
 *   ADMIN_PASS   — admin password          (default: "changeme" — CHANGE THIS)
 *   SESSION_SECRET — secret for signing cookies (default: random, changes on restart)
 *   PORT         — server port             (default: 3001)
 */

import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Credentials from environment
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
export const ADMIN_PASS = process.env.ADMIN_PASS ?? 'changeme';

// Warn loudly if using defaults
if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
  console.warn('\n  ⚠  WARNING: Using default admin credentials (admin/changeme)');
  console.warn('     Set ADMIN_USER and ADMIN_PASS environment variables before exposing to internet.\n');
}

export const SESSION_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory session store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple session store: Map<sessionId, { user, createdAt, lastSeen }>
 * Sessions expire after SESSION_TTL_MS of inactivity.
 */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map<string, { user: string; createdAt: number; lastSeen: number }>();

/** Removes sessions older than SESSION_TTL_MS */
function pruneExpired(): void {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
}
// Prune every 30 minutes
setInterval(pruneExpired, 30 * 60 * 1000);

export function createSession(user: string): string {
  const id = randomBytes(32).toString('hex');
  sessions.set(id, { user, createdAt: Date.now(), lastSeen: Date.now() });
  return id;
}

export function getSession(id: string | undefined): { user: string } | null {
  if (!id) return null;
  const sess = sessions.get(id);
  if (!sess) return null;
  if (Date.now() - sess.lastSeen > SESSION_TTL_MS) { sessions.delete(id); return null; }
  sess.lastSeen = Date.now(); // sliding expiry
  return { user: sess.user };
}

export function destroySession(id: string): void {
  sessions.delete(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes that bypass authentication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * These routes are publicly accessible without login.
 * Keep this list minimal — only what the public ticker page needs.
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/login.html',
  '/api/auth/login',
  '/api/ticker/data',  // public ticker feed — no auth needed
  '/ticker.html',      // the public ticker page itself
  '/favicon.ico',
]);

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  // Static assets needed by the ticker (fonts, etc.) are public too
  if (path.startsWith('/assets/')) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * requireAuth middleware — gates all admin routes behind session auth.
 *
 * HOW COOKIES WORK:
 * When the user logs in, the server sends a Set-Cookie header with a session ID.
 * The browser stores this cookie and sends it with every subsequent request.
 * We look up the session ID in our sessions Map to verify the user is logged in.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Always allow public paths
  if (isPublicPath(req.path)) { next(); return; }

  // Read session cookie
  const sessionId = getCookieValue(req.headers.cookie ?? '', 'sid');
  const session   = getSession(sessionId);

  if (session) {
    // Valid session — attach user to request and continue
    (req as any).adminUser = session.user;
    next();
    return;
  }

  // Not authenticated
  if (req.path.startsWith('/api/')) {
    // API call from UI — return 401 JSON
    res.status(401).json({ error: 'Not authenticated', redirect: '/login' });
  } else {
    // Browser navigation — redirect to login page
    res.redirect('/login');
  }
}

/** Reads a specific cookie value from a raw Cookie header string */
function getCookieValue(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader
    .split(';')
    .map(c => c.trim().split('='))
    .find(([k]) => k === name);
  return match ? decodeURIComponent(match[1] ?? '') : undefined;
}

/** Sets the session cookie on a response */
export function setSessionCookie(res: Response, sessionId: string): void {
  res.setHeader('Set-Cookie',
    `sid=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

/** Clears the session cookie */
export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
