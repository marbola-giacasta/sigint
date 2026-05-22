/**
 * src/utils/limit.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Trims a results array according to the user's chosen limit.
 *
 * TYPESCRIPT GENERICS: <T> means "this works for any array type".
 * applyLimit(posts, lc)   → T is inferred as Post
 * applyLimit(comments, lc)→ T is inferred as Comment
 * One function handles all cases instead of a separate function per type.
 *
 * LimitConfig shape (matches what the CLI prompts and UI form send):
 *   { mode: 'all' | 'last5' | 'specific', count: number | null }
 */
export interface LimitConfig {
  mode:  'all' | 'last5' | 'specific';
  count: number | null;
}

/**
 * Returns a trimmed slice of items based on limitConfig.
 * 'all'      → return everything unchanged
 * 'specific' → return first limitConfig.count items
 * 'last5'    → return first limitConfig.count items (default 5)
 */
export function applyLimit<T>(items: T[], lc: LimitConfig): T[] {
  // Array.slice(0, n) returns elements [0..n-1]. If n >= length, returns all.
  switch (lc.mode) {
    case 'last5':    return items.slice(0, lc.count ?? 5);
    case 'specific': return items.slice(0, lc.count ?? 5);
    default:         return items; // 'all' — no limit
  }
}
