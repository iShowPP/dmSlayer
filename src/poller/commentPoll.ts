// Comment poll (Section 5A). Reads comments only for media attached to an active campaign,
// converts them to normalized events, and feeds the engine. A conservative account-wide hourly
// cap on opening DMs guards the shared rate budget across cron ticks (Section 10).

import { getActiveCampaigns, getLiveSince, countEventsGlobal, kvGet, kvSet, markCommentProcessed, now } from "../db";
import { commentTriggers } from "../engine/match";
import type { Campaign } from "../types";
import type { Runtime } from "../runtime";
import { toUnixSeconds } from "../runtime";
import type { NormalizedComment } from "../types";
import { logActivity, loggedCommentIds } from "../log";

// Private replies cap ~750/hr; DMs ~200/hr. Openings are private replies that open a DM, so we
// pace against the stricter DM limit with margin.
const OPENING_CAP_PER_HOUR = 150;

const ERROR_KEY = "last_comment_poll_error";
const COOLDOWN_KEY = "rate_limit_until";
const USAGE_KEY = "meta_app_usage";
/** Stop sending for this check once this much of the hourly allowance is used. */
const USAGE_SOFT_STOP = 90;

/**
 * How long to stop SENDING after Meta says the request limit is reached. The allowance is a
 * rolling hour, and a refused request still counts against it, so the further over the limit the
 * app is, the longer it waits before trying one again.
 */
function cooldownSeconds(usagePercent: number | null): number {
  if (usagePercent === null) return 300;
  if (usagePercent >= 300) return 900;
  if (usagePercent >= 150) return 600;
  return 300;
}

async function recordUsage(db: D1Database, percent: number | null): Promise<void> {
  if (percent === null) return;
  await kvSet(db, USAGE_KEY, JSON.stringify({ at: now(), percent }));
}

/** Latest send-allowance usage Meta reported: { at, percent } or null. */
export async function getSendUsage(db: D1Database): Promise<{ at: number; percent: number } | null> {
  const raw = await kvGet(db, USAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: number; percent: number };
  } catch {
    return null;
  }
}

async function startCooldown(db: D1Database, what: string, usagePercent: number | null = null): Promise<void> {
  const until = now() + cooldownSeconds(usagePercent);
  await kvSet(db, COOLDOWN_KEY, String(until));
  await kvSet(db, ERROR_KEY, JSON.stringify({
    at: now(),
    message: `Meta request limit reached (${what}). Paused until ${new Date(until * 1000).toISOString().slice(11, 16)} UTC; unanswered comments are retried then.`,
  }));
  console.warn(`[dmSlayer] Meta request limit reached (${what}); sending paused ${cooldownSeconds(usagePercent)}s.`);
}

/** Unix seconds until which polling is paused for Meta's request limit (0 = not paused). */
export async function rateLimitedUntil(db: D1Database): Promise<number> {
  return Number(await kvGet(db, COOLDOWN_KEY)) || 0;
}

function isRateLimit(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { isRateLimit?: boolean }).isRateLimit);
}

/**
 * Most comments answered in one check. Each answer is two requests to Instagram (the DM and the
 * public reply) and a Worker may only make about fifty outside requests per run, so the rest wait
 * one minute for the next check — longest-waiting first, nobody dropped.
 */
const MAX_ANSWERS_PER_CHECK = 15;

/** Most extra (older) pages read per post in one check, when a whole page is comments not seen before. */
const MAX_EXTRA_PAGES = 8;

type RawComment = Awaited<ReturnType<Runtime["client"]["getComments"]>>[number];

/**
 * Read every watched post's comments. The newest page of every post comes from one batched
 * request; older pages are followed only while a page consists entirely of comments not seen
 * before — i.e. on first watching a busy post, or when more than a page arrived since last check —
 * so nothing is skipped and a quiet post still costs nothing extra.
 * Returns null when Meta refused the read for its request limit.
 */
async function readPosts(rt: Runtime, db: D1Database, mediaIds: string[]): Promise<Map<string, { comments: RawComment[]; known: Set<string> }> | null> {
  const out = new Map<string, { comments: RawComment[]; known: Set<string> }>();
  const client = rt.client;
  const paged = typeof client.getCommentsPage === "function";

  let first: Awaited<ReturnType<typeof client.getCommentsBatch>> | null = null;
  if (paged && mediaIds.length > 1) {
    try {
      first = await client.getCommentsBatch(mediaIds);
    } catch (e) {
      if (isRateLimit(e)) return null;
      console.warn(`[dmSlayer] batched comment read failed, reading posts one by one: ${e instanceof Error ? e.message : e}`);
    }
  }

  for (const mediaId of mediaIds) {
    const known = await loggedCommentIds(db, mediaId);
    try {
      if (!paged) {
        out.set(mediaId, { comments: await client.getComments(mediaId), known });
        continue;
      }
      let page = first?.get(mediaId) ?? (await client.getCommentsPage(mediaId));
      const comments = [...page.comments];
      for (let extra = 0; extra < MAX_EXTRA_PAGES && page.after && page.topIds.length > 0 && !page.topIds.some((id) => known.has(id)); extra++) {
        page = await client.getCommentsPage(mediaId, page.after);
        comments.push(...page.comments);
      }
      out.set(mediaId, { comments, known });
    } catch (e) {
      if (isRateLimit(e)) return null;
      console.warn(`[dmSlayer] reading comments of ${mediaId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

interface PendingRow {
  comment_id: string;
  igsid: string | null;
  username: string | null;
  detail: string | null;
  media_id: string;
  at: number;
}

export async function pollComments(rt: Runtime, db: D1Database): Promise<void> {
  const campaigns = await getActiveCampaigns(db);
  if (campaigns.length === 0) return;

  // Reading and sending are separate allowances at Meta. A pause on SENDING must never stop the
  // reading: every comment is still read and logged while paused, and answered when sends resume.
  let sendPaused = (await rateLimitedUntil(db)) > now();
  if (!sendPaused) {
    const openingsThisHour = await countEventsGlobal(db, "opening_sent", now() - 3600);
    if (openingsThisHour >= OPENING_CAP_PER_HOUR) {
      console.warn(`[dmSlayer] opening cap reached (${openingsThisHour}/hr); reading only this check.`);
      sendPaused = true;
    }
  }

  // Only comments made after an automation was switched on count for it. Without this, going live
  // on a post that already had keyword comments DMed everyone who had ever commented.
  const liveSince = await getLiveSince(db);
  const eligibleFor = (mediaId: string, ts: number) =>
    campaigns.filter((k) => k.media_id === mediaId && ts >= (liveSince.get(k.campaign_id) ?? 0));

  const mediaIds = [...new Set(campaigns.map((c) => c.media_id))];
  const posts = await readPosts(rt, db, mediaIds);
  if (!posts) return startCooldown(db, "reading comments");

  // Comments already finished, in one query instead of one per comment.
  const doneRows = await db
    .prepare("SELECT comment_id, campaign_id FROM processed_comments WHERE created_at > ?")
    .bind(now() - 30 * 86400)
    .all<{ comment_id: string; campaign_id: string }>();
  const done = new Map((doneRows.results ?? []).map((r) => [r.comment_id, r.campaign_id]));

  // ---- 1. log every comment read, and queue the ones still owed an answer ----
  const queue: Array<{ evt: NormalizedComment; eligible: Campaign[]; answeredElsewhere?: boolean }> = [];
  const seen = new Set<string>();
  for (const [mediaId, { comments, known }] of posts) {
    for (const c of comments) {
      // Our own comments (public replies) are not leads.
      if (c.from?.id === rt.igUserId) continue;
      seen.add(c.id);
      // Meta omits `from.id` for some commenters. A private reply only needs the comment id, so such
      // a comment is still answered; it just gets a stand-in person id, unique to that comment.
      const igsid = c.from?.id ?? `anon:${c.id}`;
      const evt: NormalizedComment = {
        kind: "comment",
        comment_id: c.id,
        igsid,
        username: c.from?.username ?? c.username,
        text: c.text ?? "",
        media_id: mediaId,
        timestamp: toUnixSeconds(c.timestamp),
      };
      const eligible = eligibleFor(mediaId, evt.timestamp);
      if (!known.has(c.id)) {
        // First sighting: record who said what. The engine fills in the outcome for live comments.
        const prior = done.get(c.id);
        const status = eligible.length === 0 ? "before_live" : prior === undefined ? "new" : prior === "-" ? "no_keyword" : "matched";
        await logActivity(db, {
          kind: "comment", status, detail: evt.text, dedupe: `comment:${c.id}`, at: evt.timestamp,
          media_id: mediaId, comment_id: c.id, igsid, username: evt.username ?? null,
        });
      }
      // A reply from this account that dmSlayer did not post (it would be finished if it had)
      // means another tool, or the owner by hand, has already answered this comment.
      const answeredElsewhere = (c.replies?.data ?? []).some((r) => r.from?.id === rt.igUserId);
      if (eligible.length > 0 && !done.has(c.id)) queue.push({ evt, eligible, answeredElsewhere });
    }
  }

  // ---- 2. comments still owed an answer that this read did not return ----
  // Once a comment has been seen it is never forgotten: if it scrolls off the pages read above
  // before it was answered (a busy post, a pause for the request limit), it is retried from here.
  const pending = await db
    .prepare(
      `SELECT comment_id, igsid, username, detail, media_id, at FROM activity_log
       WHERE kind = 'comment' AND status IN ('new', 'matched') AND at > ?
         AND comment_id NOT IN (SELECT comment_id FROM processed_comments)
       ORDER BY at ASC LIMIT 600`,
    )
    .bind(now() - 7 * 86400) // Instagram accepts a private reply for 7 days after the comment
    .all<PendingRow>();
  for (const p of pending.results ?? []) {
    if (seen.has(p.comment_id) || !mediaIds.includes(p.media_id)) continue;
    const eligible = eligibleFor(p.media_id, p.at);
    if (eligible.length === 0) continue;
    queue.push({
      evt: {
        kind: "comment", comment_id: p.comment_id, igsid: p.igsid ?? `anon:${p.comment_id}`,
        username: p.username ?? undefined, text: p.detail ?? "", media_id: p.media_id, timestamp: p.at,
      },
      eligible,
    });
  }

  if (sendPaused) return; // everything is logged; answers go out when sending resumes

  // ---- 3. answer ----
  // Order matters when Meta's allowance is smaller than the demand. Comments never tried come
  // before retries, so one that keeps failing can never hold up the line. Among the untried, turns
  // alternate between the newest (a DM that arrives while they are still looking) and the
  // longest-waiting (so the backlog always drains too).
  const tried = new Set(
    ((await db.prepare("SELECT comment_id FROM activity_log WHERE kind = 'dm' AND status = 'failed' AND n > 0").all<{ comment_id: string }>()).results ?? [])
      .map((r) => r.comment_id),
  );
  queue.sort((a, b) => a.evt.timestamp - b.evt.timestamp);
  const fresh = queue.filter((q) => !tried.has(q.evt.comment_id));
  const retries = queue.filter((q) => tried.has(q.evt.comment_id));
  const ordered: typeof queue = [];
  for (let lo = 0, hi = fresh.length - 1; lo <= hi; ) {
    ordered.push(fresh[hi--]!);
    if (lo <= hi) ordered.push(fresh[lo++]!);
  }
  ordered.push(...retries);
  queue.length = 0;
  queue.push(...ordered);
  let handled = 0;
  let failed = 0;
  let lastError = "";
  for (const { evt, eligible, answeredElsewhere } of queue) {
    // Already answered from this account by another tool or by hand: do not message them a
    // second time. Recorded in the log, so it is visible who was left to the other tool.
    const match = answeredElsewhere ? eligible.find((k) => commentTriggers(evt.text, k.keywords, k.exclude)) : undefined;
    if (match) {
      await logActivity(db, {
        kind: "comment", status: "matched", detail: evt.text, dedupe: `comment:${evt.comment_id}`, at: evt.timestamp,
        media_id: evt.media_id, campaign_id: match.campaign_id, comment_id: evt.comment_id, igsid: evt.igsid, username: evt.username ?? null,
      });
      await logActivity(db, {
        kind: "dm", status: "skipped", detail: "already answered from this account by another tool or by hand",
        dedupe: `dm:${evt.comment_id}`, media_id: evt.media_id, campaign_id: match.campaign_id,
        comment_id: evt.comment_id, igsid: evt.igsid, username: evt.username ?? null,
      });
      await markCommentProcessed(db, evt.comment_id, evt.igsid, match.campaign_id);
      continue;
    }
    // Isolated per comment: handleComment can throw, and an unguarded loop lets one poisoned
    // comment abort the whole check and starve everyone behind it. The engine only marks a comment
    // processed once it has fully succeeded, so a comment that throws here is retried next check.
    if (handled >= MAX_ANSWERS_PER_CHECK) break;
    handled++;
    try {
      await rt.engine.handleComment(evt, eligible);
    } catch (e) {
      failed++;
      lastError = e instanceof Error ? e.message : String(e);
      console.warn(`[dmSlayer] handleComment failed for ${evt.comment_id} on ${evt.media_id}: ${lastError}`);
    }
    if (rt.engine.rateLimited) break;
    // Close to the hourly allowance: stop here rather than run into the wall. Whoever is left is
    // first in line next check.
    if ((rt.client.appUsagePercent ?? 0) >= USAGE_SOFT_STOP) {
      console.warn(`[dmSlayer] send allowance ${rt.client.appUsagePercent}% used; holding the rest for the next check.`);
      break;
    }
  }
  await recordUsage(db, rt.client.appUsagePercent ?? null);

  // Isolating each comment stops one failure starving the rest — but it also means a poll in which
  // EVERY comment fails now returns normally, where it used to throw. Surface it for the dashboard.
  if (rt.engine.rateLimited) {
    return startCooldown(db, `sending, allowance ${rt.client.appUsagePercent ?? "?"}% used`, rt.client.appUsagePercent ?? null);
  }
  if (failed > 0) {
    await kvSet(db, ERROR_KEY, JSON.stringify({
      at: now(),
      message: `${failed}/${handled} comment(s) failed; last: ${lastError}`.slice(0, 300),
    }));
  } else if (await kvGet(db, ERROR_KEY)) {
    await kvSet(db, ERROR_KEY, "");
  }
}

/**
 * One comment pushed by Instagram's webhook. Same rules as the poll — our own comments ignored,
 * nothing older than the automation, recorded in the log first — so the instant path and the
 * minute-by-minute read can never disagree about who is owed an answer.
 */
export async function ingestPushedComment(rt: Runtime, db: D1Database, evt: NormalizedComment): Promise<void> {
  if (evt.igsid === rt.igUserId) return;
  const campaigns = (await getActiveCampaigns(db)).filter((k) => k.media_id === evt.media_id);
  if (campaigns.length === 0) return;
  const finished = await db.prepare("SELECT 1 FROM processed_comments WHERE comment_id = ?").bind(evt.comment_id).first();
  if (finished) return; // a repeat delivery of something already handled
  const liveSince = await getLiveSince(db);
  const eligible = campaigns.filter((k) => evt.timestamp >= (liveSince.get(k.campaign_id) ?? 0));
  if (!(await loggedCommentIds(db, evt.media_id)).has(evt.comment_id)) {
    await logActivity(db, {
      kind: "comment", status: eligible.length === 0 ? "before_live" : "new", detail: evt.text,
      dedupe: `comment:${evt.comment_id}`, at: evt.timestamp, media_id: evt.media_id,
      comment_id: evt.comment_id, igsid: evt.igsid, username: evt.username ?? null,
    });
  }
  if (eligible.length === 0) return;
  // Sending paused for the request limit: it is logged, and the poll answers it when sends resume.
  if ((await rateLimitedUntil(db)) > now()) return;
  // Allowance nearly used up (as of the last send, if recent): leave it to the poll's queue, which
  // spends what is left in a fair order, rather than letting pushes run it into the wall.
  const usage = await getSendUsage(db);
  if (usage && now() - usage.at < 600 && usage.percent >= USAGE_SOFT_STOP) return;
  await rt.engine.handleComment(evt, eligible);
  await recordUsage(db, rt.client?.appUsagePercent ?? null);
  if (rt.engine.rateLimited) {
    await startCooldown(db, `sending, allowance ${rt.client?.appUsagePercent ?? "?"}% used`, rt.client?.appUsagePercent ?? null);
  }
}

/** The last comment-poll error, for the status endpoint. Null when the last poll was clean. */
export async function getCommentPollError(db: D1Database): Promise<{ at: number; message: string } | null> {
  const raw = await kvGet(db, ERROR_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { at: number; message: string };
  } catch {
    return null;
  }
}
