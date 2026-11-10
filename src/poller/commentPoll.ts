// Comment poll (Section 5A). Reads comments only for media attached to an active campaign,
// converts them to normalized events, and feeds the engine. A conservative account-wide hourly
// cap on opening DMs guards the shared rate budget across cron ticks (Section 10).

import { getActiveCampaigns, getLiveSince, countEventsGlobal, kvGet, kvSet, now } from "../db";
import type { Runtime } from "../runtime";
import { toUnixSeconds } from "../runtime";
import type { NormalizedComment } from "../types";
import { logActivity, loggedCommentIds } from "../log";

// Private replies cap ~750/hr; DMs ~200/hr. Openings are private replies that open a DM, so we
// pace against the stricter DM limit with margin.
const OPENING_CAP_PER_HOUR = 180;

const ERROR_KEY = "last_comment_poll_error";

export async function pollComments(rt: Runtime, db: D1Database): Promise<void> {
  const campaigns = await getActiveCampaigns(db);
  if (campaigns.length === 0) return;

  const sinceHour = now() - 3600;
  const openingsThisHour = await countEventsGlobal(db, "opening_sent", sinceHour);
  if (openingsThisHour >= OPENING_CAP_PER_HOUR) {
    console.warn(`[dmSlayer] opening cap reached (${openingsThisHour}/hr); deferring comment poll.`);
    return;
  }

  // Only comments made after an automation was switched on count for it. Without this, going live
  // on a post that already had keyword comments DMed everyone who had ever commented.
  const liveSince = await getLiveSince(db);

  // Dedupe media so shared media across campaigns is fetched once.
  const mediaIds = [...new Set(campaigns.map((c) => c.media_id))];
  let handled = 0;
  let failed = 0;
  let lastError = "";
  for (const mediaId of mediaIds) {
    let comments;
    try {
      comments = await rt.client.getComments(mediaId);
    } catch (e) {
      console.warn(`[dmSlayer] getComments(${mediaId}) failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const known = await loggedCommentIds(db, mediaId);
    for (const c of comments) {
      // Our own comments (public replies) are not leads.
      if (c.from?.id === rt.igUserId) continue;
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
      // Pass the campaigns we already fetched so the engine doesn't re-query per comment.
      // Isolated per comment, for the same reason pollMessages isolates per message: handleComment
      // can throw (a rejected send, a schema mismatch, a malformed campaign), and an unguarded loop
      // lets one poisoned comment abort the whole tick — silently starving every commenter behind
      // it, on this tick and on every tick after, since the same comment is re-read each time.
      // The engine only marks a comment processed once it has fully succeeded, so a comment that
      // throws here is left unprocessed and retried cleanly on the next tick.
      const eligible = campaigns.filter((k) => evt.timestamp >= (liveSince.get(k.campaign_id) ?? 0));
      if (!known.has(c.id)) {
        // First sighting: record who said what. The engine fills in the outcome for live comments.
        let status = eligible.length === 0 ? "before_live" : "new";
        if (status === "new") {
          const done = await db.prepare("SELECT campaign_id FROM processed_comments WHERE comment_id = ?").bind(c.id).first<{ campaign_id: string }>();
          if (done) status = done.campaign_id === "-" ? "no_keyword" : "matched";
        }
        await logActivity(db, {
          kind: "comment", status, detail: evt.text, dedupe: `comment:${c.id}`, at: evt.timestamp,
          media_id: mediaId, comment_id: c.id, igsid, username: evt.username ?? null,
        });
      }
      if (eligible.length === 0) continue; // older than every automation watching this post
      handled++;
      try {
        await rt.engine.handleComment(evt, eligible);
      } catch (e) {
        failed++;
        lastError = e instanceof Error ? e.message : String(e);
        console.warn(`[dmSlayer] handleComment failed for ${c.id} on ${mediaId}: ${lastError}`);
      }
    }
  }

  // Isolating each comment stops one failure starving the rest — but it also means a poll in which
  // EVERY comment fails now returns normally, where it used to throw. Without this the dashboard
  // would read healthy while no lead had been answered for hours, which is the exact failure mode
  // the message poll's health signal was added for. Surface it the same way.
  if (failed > 0) {
    await kvSet(db, ERROR_KEY, JSON.stringify({
      at: now(),
      message: `${failed}/${handled} comment(s) failed; last: ${lastError}`.slice(0, 300),
    }));
  } else if (await kvGet(db, ERROR_KEY)) {
    await kvSet(db, ERROR_KEY, "");
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
