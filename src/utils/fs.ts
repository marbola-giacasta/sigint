/**
 * src/utils/fs.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * File system helpers.
 *
 * safeFilename: converts any string into a filename that works on all OSes.
 * Illegal characters on Windows/Mac/Linux: < > : " / \ | ? * and control chars.
 * If you skip this, creating a file named "My Video: Top 5/Tips" crashes Node.
 *
 * ensureDir: creates a folder if it doesn't exist.
 * fs.mkdirSync throws if the folder already exists — we swallow that error.
 */
import fs from 'node:fs';

/** Converts any value to a safe filename by replacing illegal characters */
export function safeFilename(s: unknown): string {
  return String(s || '')
    .replace(/\r?\n|\r/g, ' ')              // newlines → space
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // illegal chars → underscore
    .trim()
    .slice(0, 200);                          // max 200 chars (OS path limit safety)
}

/**
 * Creates a directory (and all parent dirs) if it doesn't already exist.
 * Safe to call repeatedly — does nothing if folder already exists.
 */
export function ensureDir(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true }); // recursive: create parents too
  } catch {
    // Ignore "already exists" error — that's the normal case
  }
}
