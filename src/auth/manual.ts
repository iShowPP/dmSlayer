// Manual connection: use an access token generated in the Meta app dashboard
// (Use cases -> Customize -> "Generate access tokens" -> Generate token) instead of the OAuth
// redirect. For a single owner connecting their own account this is the most direct route, and it
// is the fallback when Meta's login dialog completes without attaching the Instagram account.
//
// Set IG_ACCESS_TOKEN (and IG_USER_ID, the number shown under the account name) in .dev.vars.

import { InstagramClient, listAssignedInstagramAccounts } from "../api/client";
import { getAuth, kvGet, kvSet, now, saveAuth } from "../db";
import type { Env } from "../types";

const FP_KEY = "manual_token_fp";
const ERR_KEY = "manual_token_error";
const DAY = 86400;

/**
 * Which API a token belongs to. Instagram-login tokens start with "IG" and only work on
 * graph.instagram.com; everything else (system-user / Facebook-login tokens, "EAA…") only works
 * on graph.facebook.com.
 */
export function tokenIsUnified(token: string): boolean {
  return !token.startsWith("IG");
}

function configured(v: string | undefined): string {
  const s = (v ?? "").trim();
  return s.startsWith("PASTE") ? "" : s;
}

async function fingerprint(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Last error from importing the manual token, for the dashboard ("" when fine / unused). */
export async function manualTokenError(db: D1Database): Promise<string> {
  return (await kvGet(db, ERR_KEY)) ?? "";
}

/**
 * Import IG_ACCESS_TOKEN into the auth row, once per distinct token. The fingerprint check matters:
 * a refreshed token replaces the stored one, and re-importing the original on every request would
 * silently roll the instance back to a token that is about to expire.
 */
export async function ensureManualAuth(env: Env): Promise<void> {
  const token = configured(env.IG_ACCESS_TOKEN);
  if (!token) return;
  const fp = await fingerprint(token);
  if ((await kvGet(env.DB, FP_KEY)) === fp && (await getAuth(env.DB))) return;

  try {
    const unified = tokenIsUnified(token);
    let igUserId = configured(env.IG_USER_ID);
    if (!igUserId && unified) {
      const accounts = await listAssignedInstagramAccounts(env.GRAPH_VERSION, token);
      igUserId = accounts[0]?.id ?? "";
      if (!igUserId) throw new Error("Set IG_USER_ID in .dev.vars to the number shown under your account name in the Meta app.");
    }
    const client = new InstagramClient(token, env.GRAPH_VERSION, igUserId || "me", unified);
    const me = await client.getMe();
    await saveAuth(env.DB, {
      access_token: token,
      // The dashboard token's real lifetime is not reported here. Instagram-login tokens last about
      // 60 days and are renewed by the daily refresh; system-user tokens default to never expiring.
      expires_at: now() + (unified ? 3650 : 60) * DAY,
      ig_user_id: igUserId || me.user_id,
      username: me.username ?? null,
      account_type: me.account_type ?? "BUSINESS",
      profile_picture_url: me.profile_picture_url ?? null,
    });
    await kvSet(env.DB, FP_KEY, fp);
    await kvSet(env.DB, ERR_KEY, "");
    console.log(`[dmSlayer] connected @${me.username} from IG_ACCESS_TOKEN (${unified ? "graph.facebook.com" : "graph.instagram.com"})`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await kvSet(env.DB, ERR_KEY, detail);
    console.warn(`[dmSlayer] IG_ACCESS_TOKEN could not be used: ${detail}`);
  }
}
