// Token refresh (Section 9). Runs on the daily cron. A long-lived token must be >24h old and
// unexpired to refresh; refreshing extends it ~60 days. If it lapses past 60 days it is dead and
// the owner must re-connect. We refresh proactively when within ~30 days of expiry.

import { getAuth, saveAuth, now } from "../db";
import { refreshLongLivedToken } from "../api/client";
import type { Env } from "../types";
import { tokenIsUnified } from "./manual";

const DAY = 86400;
const REFRESH_WHEN_WITHIN = 30 * DAY; // refresh once the token is within 30 days of expiry
const MIN_TOKEN_AGE = DAY + 3600; // must be >24h old (+1h margin) to be refreshable

export interface RefreshResult {
  status: "refreshed" | "skipped" | "no_auth" | "too_new" | "expired" | "error";
  detail?: string;
  expiresAt?: number;
}

export async function refreshTokenIfDue(env: Env): Promise<RefreshResult> {
  const auth = await getAuth(env.DB);
  if (!auth) return { status: "no_auth" };

  const ts = now();

  if (auth.expires_at <= ts) {
    // Past its life — cannot refresh, owner must re-connect. Loud warning (Section 9).
    console.warn(
      `[dmSlayer] access token EXPIRED at ${new Date(auth.expires_at * 1000).toISOString()}; owner must reconnect Instagram.`,
    );
    return { status: "expired" };
  }

  // Unified-login tokens are system-user tokens: the Instagram-login refresh endpoint does not
  // apply to them. Their lifetime is whatever the Meta configuration set (default: never expires).
  if (tokenIsUnified(auth.access_token)) return { status: "skipped", expiresAt: auth.expires_at };

  // Not yet within the refresh window — nothing to do this tick.
  if (auth.expires_at - ts > REFRESH_WHEN_WITHIN) {
    return { status: "skipped", expiresAt: auth.expires_at };
  }

  // Token must be old enough to refresh.
  const lastSet = auth.refreshed_at ?? auth.expires_at - 60 * DAY;
  if (ts - lastSet < MIN_TOKEN_AGE) {
    return { status: "too_new", expiresAt: auth.expires_at };
  }

  try {
    const { access_token, expires_in } = await refreshLongLivedToken(env.GRAPH_VERSION, auth.access_token);
    const expiresAt = now() + expires_in;
    await saveAuth(env.DB, { access_token, expires_at: expiresAt });
    console.log(`[dmSlayer] token refreshed; new expiry ${new Date(expiresAt * 1000).toISOString()}`);
    return { status: "refreshed", expiresAt };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[dmSlayer] token refresh FAILED (${detail}); expiry ${new Date(auth.expires_at * 1000).toISOString()}`);
    return { status: "error", detail, expiresAt: auth.expires_at };
  }
}
