// Pure matching helpers. Whole-word, case-insensitive keyword matching (Section 6, Step 0):
// keyword "ai" fires on "I like this ai" / "AI rocks!" / "love ai!" but NOT "fair" / "rain".

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `keyword` appears as a standalone word in `text` (case-insensitive). Uses a
 * Unicode-aware boundary — NOT String.includes(), which would wrongly fire "ai" inside "fair",
 * and NOT a plain `\b`, which is ASCII-only ([A-Za-z0-9_]) and silently fails to bound any
 * keyword or comment containing an accented letter (e.g. "café", "mañana") even when the case
 * matches exactly. Lookaround on \p{L}/\p{N} keeps the boundary correct for any script while
 * still treating emoji/punctuation as boundaries.
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  const kw = keyword.trim();
  if (!kw) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(kw)}(?![\\p{L}\\p{N}_])`, "iu");
  return re.test(text);
}

/** Edit distance between two strings is at most one (one letter added, dropped or swapped out). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/**
 * Forgiving trigger match, for how people actually type a keyword in comments:
 *   - spaced or hyphenated: "Tik tok", "tik-tok" for the keyword "tiktok" (and "tier1" for "tier 1")
 *   - one typo, for keywords of six or more letters: "Tiltok", "tiktoks"
 * Still whole words only: adjacent words are joined and compared, never searched as a substring,
 * so "ai" does not fire inside "fair". Keywords under four letters, or containing punctuation
 * (e.g. "node.js"), keep the exact rule.
 */
export function matchesKeywordLoose(text: string, keyword: string): boolean {
  if (matchesKeyword(text, keyword)) return true;
  const kw = keyword.trim().toLowerCase();
  if (/[^\p{L}\p{N}\s]/u.test(kw)) return false;
  const k = kw.replace(/\s+/g, "");
  if (k.length < 4) return false;
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let joined = "";
    for (let j = i; j < words.length && j < i + 4; j++) {
      joined += words[j];
      if (joined.length > k.length + 1) break;
      if (joined === k) return true;
      if (k.length >= 6 && withinOneEdit(joined, k)) return true;
    }
  }
  return false;
}

/** True if any keyword matches (whole words; forgiving about spacing and a single typo). */
export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => matchesKeywordLoose(text, k));
}

/** True if any excluded word is present (same whole-word rule); any match cancels the trigger. */
export function hasExcludedWord(text: string, exclude: string[] | undefined): boolean {
  if (!exclude || exclude.length === 0) return false;
  return exclude.some((w) => matchesKeyword(text, w));
}

/** A comment triggers a campaign when a keyword matches AND no excluded word is present. */
export function commentTriggers(text: string, keywords: string[], exclude?: string[]): boolean {
  return matchesAnyKeyword(text, keywords) && !hasExcludedWord(text, exclude);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Extract a valid email from free text (chip fallback: user types their address). */
export function extractEmail(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (EMAIL_RE.test(trimmed)) return trimmed;
  // Also catch an email embedded in a longer reply.
  const m = trimmed.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return m ? m[0] : null;
}
