// The comment poll's promises: every comment is read (paging past the first page when needed),
// a comment once seen is never forgotten, a pause on sending never stops the reading, and a
// "request limit" answer from Meta stops the sending instead of hammering.

import { describe, expect, it } from "vitest";
import { InstagramApiError } from "../src/api/client";
import type { CommentPage, IgComment } from "../src/api/client";
import { kvGet, kvSet, now, upsertCampaign } from "../src/db";
import { Engine } from "../src/engine/engine";
import { pollComments, rateLimitedUntil } from "../src/poller/commentPoll";
import { SendQueue } from "../src/queue/queue";
import type { Runtime } from "../src/runtime";
import type { Campaign } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";

const ME = "me-1";

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    campaign_id: "c1", media_id: "reel_1", keywords: ["tiktok"], exclude: [], direct_delivery: true,
    reward: { type: "link", value: "https://x.com/g" },
    copy: { opening: "tap", delivery: "here {reward}" },
    ...over,
  };
}

/** A comment posted `secondsAhead` seconds from now (so it is after the automation went live). */
function cmt(id: string, user: string, text: string, secondsAhead: number): IgComment {
  return { id, text, username: user, from: { id: `u-${user}`, username: user }, timestamp: new Date((now() + secondsAhead) * 1000).toISOString() };
}

class PagedClient {
  /** media id -> pages, newest page first. */
  pages = new Map<string, IgComment[][]>();
  sent: Array<{ commentId: string; text: string }> = [];
  replies: string[] = [];
  reads = 0;
  /** When set, every private reply is refused with this error. */
  sendError: InstagramApiError | null = null;

  private page(mediaId: string, index: number): CommentPage {
    const all = this.pages.get(mediaId) ?? [];
    const data = all[index] ?? [];
    return { comments: data, topIds: data.map((c) => c.id), after: index + 1 < all.length ? String(index + 1) : undefined };
  }
  async getCommentsBatch(ids: string[]) {
    this.reads++;
    return new Map(ids.map((id) => [id, this.page(id, 0)]));
  }
  async getCommentsPage(mediaId: string, after?: string) {
    this.reads++;
    return this.page(mediaId, after ? Number(after) : 0);
  }
  async getComments(mediaId: string) {
    return this.page(mediaId, 0).comments;
  }
  async privateReplyText(commentId: string, text: string) {
    if (this.sendError) throw this.sendError;
    this.sent.push({ commentId, text });
    return { message_id: "m" };
  }
  async replyToComment(commentId: string) {
    this.replies.push(commentId);
    return { id: "r" };
  }
  async sendText() {
    throw new InstagramApiError("outside the allowed window", 400, 10);
  }
}

async function setup(camps: Campaign[] = [campaign()]) {
  const db = makeTestDb();
  for (const c of camps) await upsertCampaign(db, c, true);
  const client = new PagedClient();
  const engine = new Engine(db, client as never, new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 }));
  const rt = { client, engine, igUserId: ME } as unknown as Runtime;
  // A fresh engine per poll, as in production, so its rate-limit flag does not carry over.
  const poll = () => {
    (rt as { engine: Engine }).engine = new Engine(db, client as never, new SendQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 0 }));
    return pollComments(rt, db);
  };
  const logged = async () =>
    ((await db.prepare("SELECT comment_id, status FROM activity_log WHERE kind = 'comment' ORDER BY comment_id").all<{ comment_id: string; status: string }>()).results ?? []);
  return { db, client, poll, logged };
}

describe("comment poll", () => {
  it("pages past the first page while a page is all comments it has not seen", async () => {
    const { client, poll } = await setup();
    client.pages.set("reel_1", [
      [cmt("a3", "cat", "tiktok", 30)],
      [cmt("a2", "bob", "Tik tok", 20)],
      [cmt("a1", "ann", "tiktok", 10)],
    ]);
    await poll();
    expect(client.sent.map((s) => s.commentId)).toEqual(["a1", "a2", "a3"]); // all three, oldest first
  });

  it("stops paging at the first page that holds a comment it already knows", async () => {
    const { client, poll } = await setup();
    client.pages.set("reel_1", [[cmt("a1", "ann", "tiktok", 10)], [cmt("a0", "old", "hello", 5)]]);
    await poll();
    const before = client.reads;
    client.pages.set("reel_1", [[cmt("a2", "bob", "tiktok", 20), cmt("a1", "ann", "tiktok", 10)], [cmt("a0", "old", "hello", 5)]]);
    await poll();
    expect(client.reads - before).toBe(1); // one read: page 1 contained a known comment
    expect(client.sent.map((s) => s.commentId)).toEqual(["a1", "a2"]);
  });

  it("never forgets a comment: one that is no longer returned is still answered", async () => {
    const { db, client, poll } = await setup();
    client.pages.set("reel_1", [[cmt("a1", "ann", "tiktok", 10)]]);
    client.sendError = new InstagramApiError("(#4) Application request limit reached", 400, 4);
    await poll(); // seen and logged, but the send is refused
    expect(client.sent).toHaveLength(0);

    client.sendError = null;
    client.pages.set("reel_1", [[cmt("z9", "new", "nice video", 60)]]); // a1 has scrolled away
    await kvSet(db, "rate_limit_until", "0"); // jump past the pause the refused send started
    await poll();
    expect(client.sent.map((s) => s.commentId)).toEqual(["a1"]);
  });

  it("a pause on sending does not stop the reading", async () => {
    const { db, client, poll, logged } = await setup();
    await kvSet(db, "rate_limit_until", String(now() + 600));
    client.pages.set("reel_1", [[cmt("a1", "ann", "tiktok", 10)]]);
    await poll();
    expect(client.sent).toHaveLength(0); // nothing sent while paused
    expect(await logged()).toEqual([{ comment_id: "a1", status: "new" }]); // but read and recorded

    await kvSet(db, "rate_limit_until", "0");
    await poll();
    expect(client.sent.map((s) => s.commentId)).toEqual(["a1"]);
  });

  it("Meta's request-limit answer stops the sending for this check and starts a pause", async () => {
    const { db, client, poll } = await setup();
    client.pages.set("reel_1", [[cmt("a2", "bob", "tiktok", 20), cmt("a1", "ann", "tiktok", 10)]]);
    let attempts = 0;
    client.privateReplyText = async () => {
      attempts++;
      throw new InstagramApiError("(#4) Application request limit reached", 400, 4);
    };
    await poll();
    expect(attempts).toBe(1); // the second person is not tried against a closed door
    expect(await rateLimitedUntil(db)).toBeGreaterThan(now());
    expect(await kvGet(db, "last_comment_poll_error")).toContain("request limit");
  });

  it("does not message someone another tool has already answered", async () => {
    const { client, poll } = await setup();
    const answered = { ...cmt("a1", "ann", "tiktok", 10), replies: { data: [{ ...cmt("r1", "me", "check your dms", 12), from: { id: ME, username: "me" } }] } };
    client.pages.set("reel_1", [[cmt("a2", "bob", "tiktok", 20), answered]]);
    await poll();
    expect(client.sent.map((s) => s.commentId)).toEqual(["a2"]); // only the one nobody answered
    await poll();
    expect(client.sent).toHaveLength(1); // and it stays that way
  });

  it("ignores our own comments and comments older than the automation", async () => {
    const { client, poll, logged } = await setup();
    const mine = { ...cmt("m1", "me", "tiktok", 10), from: { id: ME, username: "me" } };
    client.pages.set("reel_1", [[mine, cmt("o1", "old", "tiktok", -3600)]]);
    await poll();
    expect(client.sent).toHaveLength(0);
    expect(await logged()).toEqual([{ comment_id: "o1", status: "before_live" }]);
  });
});
