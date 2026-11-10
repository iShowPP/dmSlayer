// OAuth onboarding routes (Section 4A). "Connect Instagram" → authorize redirect → callback
// code exchange → long-lived token stored in auth. Plus connection status + disconnect.

import {
  buildAuthorizeUrl,
  buildUnifiedAuthorizeUrl,
  exchangeCodeForShortLivedToken,
  exchangeCodeForUnifiedToken,
  exchangeForLongLivedToken,
} from "../auth/oauth";
import { InstagramClient, WEBHOOK_FIELDS, listAssignedInstagramAccounts } from "../api/client";
import { isUnified } from "../runtime";
import { clearAuth, getAuth, kvGet, kvSet, now, saveAuth } from "../db";
import { getPollAgeSeconds, getPollError } from "../poller/messagePoll";
import { getCommentPollError } from "../poller/commentPoll";
import type { Env } from "../types";
import { json, redirect, html } from "./http";

const STATE_KEY = "oauth_state";

function randomState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** GET /auth/authorize — start the OAuth flow. */
export async function handleAuthorize(env: Env): Promise<Response> {
  if (!env.APP_ID || !env.APP_SECRET) {
    return json({ error: "APP_ID/APP_SECRET not configured" }, 500);
  }
  const state = randomState();
  await kvSet(env.DB, STATE_KEY, state);
  if (isUnified(env)) {
    return redirect(buildUnifiedAuthorizeUrl(env.APP_ID, env.CONFIG_ID!.trim(), env.REDIRECT_URI, state));
  }
  return redirect(buildAuthorizeUrl(env.APP_ID, env.REDIRECT_URI, state));
}

/** GET /auth/callback — exchange the code, verify the account is professional, store the token. */
export async function handleCallback(env: Env, url: URL): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    const why = url.searchParams.get("error_description") ?? url.searchParams.get("error_reason") ?? "";
    return html(`<h1>Connection cancelled</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(why)}</p>`, 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return html("<h1>Missing authorization code</h1>", 400);

  const expected = await kvGet(env.DB, STATE_KEY);
  if (!expected || state !== expected) return html("<h1>Invalid state (possible CSRF)</h1>", 400);

  try {
    if (isUnified(env)) return await finishUnifiedConnect(env, code);
    const short = await exchangeCodeForShortLivedToken(env.APP_ID, env.APP_SECRET, env.REDIRECT_URI, code);
    // Diagnostic: Meta can silently grant fewer scopes than requested (e.g. a permission not yet
    // enabled for this app in the dashboard). Log what was actually granted vs. requested so a
    // "why can't I read comments" report can be root-caused without guessing.
    console.log(`[dmSlayer] OAuth granted permissions: ${JSON.stringify(short.permissions ?? "none reported")}`);
    const long = await exchangeForLongLivedToken(env.GRAPH_VERSION, env.APP_SECRET, short.accessToken);

    // Fetch the profile to enforce the professional-account requirement + power the UI preview.
    const client = new InstagramClient(long.accessToken, env.GRAPH_VERSION, "me");
    const me = await client.getMe();
    const accountType = (me.account_type ?? "").toUpperCase();
    if (accountType === "PERSONAL") {
      return html(
        `<h1>Personal accounts aren't supported</h1>
         <p>dmSlayer needs an Instagram <b>Professional</b> (Creator or Business) account.</p>
         <p>In the Instagram app: <b>Settings → Account type and tools → Switch to professional account</b>, then reconnect.</p>`,
        400,
      );
    }

    // Takeover guard. /auth/callback is necessarily public (Instagram calls it), and auth is a
    // single global row, so without this check anyone who completes the flow would silently
    // replace the owner's stored token with their own account. Connecting a different account
    // requires an explicit Disconnect from the dashboard first.
    const incomingUserId = me.user_id ?? short.userId;
    const existing = await getAuth(env.DB);
    if (existing && existing.ig_user_id && existing.ig_user_id !== incomingUserId) {
      return html(
        `<h1>Already connected</h1>
         <p>This dmSlayer instance is already connected to <b>@${escapeHtml(existing.username ?? existing.ig_user_id)}</b>.</p>
         <p>To connect a different account, open your dashboard and click <b>Disconnect</b> first.</p>`,
        409,
      );
    }

    await saveAuth(env.DB, {
      access_token: long.accessToken,
      expires_at: now() + long.expiresIn,
      ig_user_id: incomingUserId,
      username: me.username ?? null,
      account_type: me.account_type ?? null,
      profile_picture_url: me.profile_picture_url ?? null,
    });

    // Subscribe the account to the app's webhooks — ALWAYS, not only when MODE is "webhook".
    //
    // Pushed events are processed whatever MODE says (see routes/webhook.ts); MODE governs only the
    // cron cadence. So "polling" plus a configured callback URL is a real and desirable setup —
    // instant delivery, with a frequent poll underneath as a safety net — and this instance runs
    // exactly that. Gating the subscribe on MODE meant such a setup lost its subscription the next
    // time the owner reconnected Instagram, after a token expiry or a disconnect/reconnect. Push
    // would then stop dead, delivery would quietly drop back to poll speed, and nothing would say
    // why: no error, no log, just slower.
    //
    // Subscribing when no callback URL is registered costs one API call and delivers nothing, so
    // doing it unconditionally is safe. Non-fatal — the connection itself already succeeded, and
    // /admin/webhook can retry and report.
    let webhookNote = "";
    {
      try {
        const client2 = new InstagramClient(long.accessToken, env.GRAPH_VERSION, incomingUserId);
        await client2.subscribeToWebhooks();
        webhookNote = `<p>Subscribed this account to <code>${escapeHtml(WEBHOOK_FIELDS)}</code> webhooks. Events arrive instantly once the callback URL is set in your Meta app; polling keeps running underneath either way.</p>`;
      } catch (e) {
        const detail = escapeHtml(e instanceof Error ? e.message : String(e));
        console.warn(`[dmSlayer] webhook subscribe failed: ${detail}`);
        webhookNote =
          `<p>⚠️ Connected, but subscribing this account to webhooks failed:</p><pre>${detail}</pre>` +
          `<p>Polling still works. To get instant delivery, retry with <code>POST /admin/webhook</code> using your owner token.</p>`;
      }
    }

    return html(
      `<h1>Connected ✅</h1>
       <p>@${escapeHtml(me.username ?? "your account")} is now connected to dmSlayer.</p>
       <p>Token valid ~60 days; it auto-refreshes. You can close this tab.</p>
       ${webhookNote}`,
    );
  } catch (e) {
    return html(`<h1>Connection failed</h1><pre>${escapeHtml(e instanceof Error ? e.message : String(e))}</pre>`, 500);
  }
}

interface TokenInfo {
  type?: string;
  scopes?: string[];
  granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
}

/** Ask Meta what a token was actually granted (app-token authenticated; returns no secrets). */
async function inspectToken(env: Env, token: string): Promise<TokenInfo> {
  const url = new URL(`https://graph.facebook.com/${env.GRAPH_VERSION}/debug_token`);
  url.searchParams.set("input_token", token);
  url.searchParams.set("access_token", `${env.APP_ID}|${env.APP_SECRET}`);
  const res = await fetch(url.toString());
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 300));
  return (JSON.parse(text) as { data?: TokenInfo }).data ?? {};
}

/** A never-expiring system-user token still needs an expiry for the auth row; use ten years. */
const NO_EXPIRY_SECONDS = 10 * 365 * 86400;

/**
 * Callback for Unified-login apps: exchange the code for the system-user token, find the Instagram
 * account it was granted, store it. Same takeover guard as the Instagram-login path.
 */
async function finishUnifiedConnect(env: Env, code: string): Promise<Response> {
  const tok = await exchangeCodeForUnifiedToken(env.GRAPH_VERSION, env.APP_ID, env.APP_SECRET, env.REDIRECT_URI, code);
  const diag: string[] = [];
  let accounts: Array<{ id: string; username?: string }> = [];
  try {
    accounts = await listAssignedInstagramAccounts(env.GRAPH_VERSION, tok.accessToken);
    diag.push(`assigned_instagram_accounts: ${accounts.length}`);
  } catch (e) {
    diag.push(`assigned_instagram_accounts failed: ${e instanceof Error ? e.message : e}`);
  }
  // Fallback: the token's own grant record names the Instagram accounts each permission covers.
  if (accounts.length === 0) {
    try {
      const info = await inspectToken(env, tok.accessToken);
      diag.push(`token type: ${info.type ?? "?"}; scopes: ${(info.scopes ?? []).join(", ") || "none"}`);
      const ids = new Set<string>();
      for (const g of info.granular_scopes ?? []) {
        diag.push(`${g.scope}: ${(g.target_ids ?? []).length} target(s)`);
        if (g.scope.startsWith("instagram_")) for (const id of g.target_ids ?? []) ids.add(id);
      }
      accounts = [...ids].map((id) => ({ id }));
    } catch (e) {
      diag.push(`token inspection failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Last resort: look for Instagram accounts through the business portfolio and its Pages.
  if (accounts.length === 0) {
    const probe = async (label: string, path: string, fields: string): Promise<Array<Record<string, any>>> => {
      try {
        const url = new URL(`https://graph.facebook.com/${env.GRAPH_VERSION}${path}`);
        url.searchParams.set("fields", fields);
        url.searchParams.set("access_token", tok.accessToken);
        const res = await fetch(url.toString());
        const body = (await res.json()) as { data?: Array<Record<string, any>>; error?: { message?: string } } & Record<string, any>;
        if (!res.ok) {
          diag.push(`${label}: error: ${body.error?.message ?? res.status}`);
          return [];
        }
        const rows = body.data ?? [body];
        diag.push(`${label}: ${body.data ? rows.length : "ok"}`);
        return rows;
      } catch (e) {
        diag.push(`${label}: failed: ${e instanceof Error ? e.message : e}`);
        return [];
      }
    };
    const me = (await probe("me", "/me", "id,name,client_business_id"))[0];
    const biz = me?.client_business_id as string | undefined;
    diag.push(`business portfolio id: ${biz ?? "not reported"}`);
    const found = new Map<string, string | undefined>();
    if (biz) {
      for (const edge of ["owned_instagram_accounts", "instagram_accounts"]) {
        for (const r of await probe(edge, `/${biz}/${edge}`, "id,username")) if (r.id) found.set(String(r.id), r.username);
      }
    }
    for (const edge of ["/me/assigned_pages", "/me/accounts"]) {
      for (const r of await probe(edge, edge, "id,name,instagram_business_account{id,username}")) {
        const ig = r.instagram_business_account;
        if (ig?.id) found.set(String(ig.id), ig.username);
      }
    }
    accounts = [...found].map(([id, username]) => ({ id, username }));
  }
  if (accounts.length === 0) {
    return html(
      `<h1>No Instagram account was shared</h1>
       <p>The login worked, but Meta did not grant this app any Instagram account.</p>
       <p>Click <b>Connect Instagram</b> again and make sure an Instagram account is chosen on Meta's
       "Select the business assets" screen before pressing Next, then approve every step to the end.
       The account must be a Professional account.</p>
       <p>Details (safe to share, no secrets):</p><pre>${escapeHtml(diag.join("\n"))}</pre>`,
      400,
    );
  }

  const existing = await getAuth(env.DB);
  // Reconnecting keeps the account already in use; a first connect takes the first one shared.
  const account = accounts.find((a) => a.id === existing?.ig_user_id) ?? accounts[0]!;
  if (existing && existing.ig_user_id && existing.ig_user_id !== account.id) {
    return html(
      `<h1>Already connected</h1>
       <p>This dmSlayer instance is already connected to <b>@${escapeHtml(existing.username ?? existing.ig_user_id)}</b>.</p>
       <p>To connect a different account, open your dashboard and click <b>Disconnect</b> first.</p>`,
      409,
    );
  }

  const client = new InstagramClient(tok.accessToken, env.GRAPH_VERSION, account.id, true);
  let profile: { username?: string; profile_picture_url?: string } = { username: account.username };
  try {
    profile = await client.getMe();
  } catch (e) {
    console.warn(`[dmSlayer] profile read failed (continuing): ${e instanceof Error ? e.message : e}`);
  }

  await saveAuth(env.DB, {
    access_token: tok.accessToken,
    expires_at: now() + (tok.expiresIn ?? NO_EXPIRY_SECONDS),
    ig_user_id: account.id,
    username: profile.username ?? account.username ?? null,
    account_type: "BUSINESS",
    profile_picture_url: profile.profile_picture_url ?? null,
  });

  let webhookNote = "";
  try {
    await client.subscribeToWebhooks();
  } catch (e) {
    // Expected on a local install with no public callback URL; polling does the work.
    webhookNote = `<p style="color:#888">Webhook subscription skipped: ${escapeHtml(e instanceof Error ? e.message : String(e))}. Polling is used instead.</p>`;
  }
  const others = accounts.length > 1 ? `<p>(${accounts.length} accounts were shared; using the first.)</p>` : "";
  return html(
    `<h1>Connected ✅</h1>
     <p>@${escapeHtml(profile.username ?? account.username ?? "your account")} is now connected to dmSlayer.</p>
     ${others}${webhookNote}
     <p><a href="/">Back to the dashboard</a></p>`,
  );
}

/** GET /auth/status — connection status (owner-only). */
export async function handleStatus(env: Env): Promise<Response> {
  const auth = await getAuth(env.DB);
  if (!auth) return json({ connected: false });
  // Poll health. A stalled poller used to be completely invisible from the outside: the dashboard
  // looked fine while no message had been processed for hours. poll_age_seconds is the tell —
  // a healthy message poll refreshes its cursor every tick, so anything beyond a few minutes
  // means the poller is not completing.
  const pollAge = await getPollAgeSeconds(env.DB);
  const pollError = await getPollError(env.DB);
  const commentPollError = await getCommentPollError(env.DB);
  return json({
    connected: true,
    username: auth.username,
    account_type: auth.account_type,
    profile_picture_url: auth.profile_picture_url,
    ig_user_id: auth.ig_user_id,
    expires_at: auth.expires_at,
    expires_in_days: Math.max(0, Math.round((auth.expires_at - now()) / 86400)),
    poll_age_seconds: pollAge,
    poll_healthy: pollAge !== null && pollAge < 600 && !commentPollError,
    poll_error: pollError,
    comment_poll_error: commentPollError,
  });
}

/** POST /auth/disconnect — clear the token (owner-only). */
export async function handleDisconnect(env: Env): Promise<Response> {
  await clearAuth(env.DB);
  return json({ disconnected: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
