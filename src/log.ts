// Activity log: what happened to every comment and every person, per video. Written by the
// comment poll and the engine; read by the Logs page. Logging must never break a send, so every
// write swallows its own errors (e.g. a database that has not been migrated yet).

import { now } from "./db";

export type LogKind = "comment" | "public_reply" | "dm" | "tap" | "follow" | "email" | "link";

export interface LogEntry {
  kind: LogKind;
  status: string;
  media_id?: string | null;
  campaign_id?: string | null;
  comment_id?: string | null;
  igsid?: string | null;
  username?: string | null;
  detail?: string | null;
  /** When set, a repeat of the same thing updates the existing row (and counts it) instead of adding one. */
  dedupe?: string | null;
  /** Unix seconds; defaults to now. Comments use the time Instagram says they were posted. */
  at?: number;
  /** False = update the row without counting it as another attempt (`n` stays as it was). */
  count?: boolean;
}

export async function logActivity(db: D1Database, e: LogEntry): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO activity_log (at, media_id, campaign_id, comment_id, igsid, username, kind, status, detail, dedupe)
         VALUES (?1, ?2, ?3, ?4, ?5,
                 COALESCE(?6, (SELECT username FROM conversations WHERE igsid = ?5 AND campaign_id = ?3)),
                 ?7, ?8, ?9, ?10)
         ON CONFLICT(dedupe) DO UPDATE SET
           status = excluded.status,
           detail = COALESCE(excluded.detail, activity_log.detail),
           campaign_id = COALESCE(excluded.campaign_id, activity_log.campaign_id),
           username = COALESCE(excluded.username, activity_log.username),
           n = activity_log.n + (CASE WHEN excluded.kind = 'comment' THEN 0 ELSE ?11 END)`,
      )
      .bind(
        e.at ?? now(),
        e.media_id ?? null,
        e.campaign_id ?? null,
        e.comment_id ?? null,
        e.igsid ?? null,
        e.username ?? null,
        e.kind,
        e.status,
        e.detail ? e.detail.slice(0, 500) : null,
        e.dedupe ?? null,
        e.count === false ? 0 : 1,
      )
      .run();
  } catch (err) {
    console.warn(`[dmSlayer] activity log write failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** How many counted attempts the row with this dedupe key has had (0 if there is none). */
export async function attemptsFor(db: D1Database, dedupe: string): Promise<number> {
  try {
    const row = await db.prepare("SELECT n FROM activity_log WHERE dedupe = ?").bind(dedupe).first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Comment ids already logged for a post, so the poll writes each comment once, not every tick. */
export async function loggedCommentIds(db: D1Database, mediaId: string): Promise<Set<string>> {
  try {
    const rows = await db
      .prepare("SELECT comment_id FROM activity_log WHERE media_id = ? AND kind = 'comment'")
      .bind(mediaId)
      .all<{ comment_id: string }>();
    return new Set((rows.results ?? []).map((r) => r.comment_id));
  } catch {
    return new Set();
  }
}

export interface LogRow {
  id: number;
  at: number;
  media_id: string | null;
  campaign_id: string | null;
  comment_id: string | null;
  igsid: string | null;
  username: string | null;
  kind: LogKind;
  status: string;
  detail: string | null;
  n: number;
}

/** Per-video totals for the Logs index. */
export async function logSummary(db: D1Database): Promise<Array<Record<string, number | string | null>>> {
  const rows = await db
    .prepare(
      `SELECT media_id,
              SUM(kind = 'comment') AS comments,
              SUM(kind = 'comment' AND status = 'matched') AS matched,
              COUNT(DISTINCT CASE WHEN kind = 'comment' THEN igsid END) AS people,
              SUM(kind = 'public_reply' AND status = 'sent') AS replies,
              SUM(kind = 'dm' AND status = 'sent') AS dms,
              SUM(kind = 'tap') AS taps,
              SUM(kind = 'link' AND status = 'sent') AS links,
              SUM(status IN ('failed', 'blocked')) AS failed,
              MAX(at) AS last_at
       FROM activity_log WHERE media_id IS NOT NULL GROUP BY media_id ORDER BY last_at DESC`,
    )
    .all<Record<string, number | string | null>>();
  return rows.results ?? [];
}

/** Every log row for one video, newest first. */
export async function logRows(db: D1Database, mediaId: string, limit = 2000): Promise<LogRow[]> {
  const rows = await db
    .prepare("SELECT * FROM activity_log WHERE media_id = ? ORDER BY at DESC, id DESC LIMIT ?")
    .bind(mediaId, limit)
    .all<LogRow>();
  return rows.results ?? [];
}
