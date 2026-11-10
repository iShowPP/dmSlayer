# dmSlayer — Meta App Review submission notes

Working notes for submitting the "DmSlayer-IG" Meta app for Advanced Access, so
`instagram_business_manage_comments` and `instagram_business_manage_messages` work for people who
comment on the connected account's posts without being added as an Instagram Tester first.

Everything below describes what dmSlayer actually does, written from its own code — not adapted
from any other project's submission.

---

## Prerequisites checklist

- [x] Business Verification — has a registered business entity
- [x] All three permissions added under **Use cases → Manage messaging & content on Instagram →
      Permissions and features** (not just requested in the OAuth scope string — see
      [HANDOFF.md](../HANDOFF.md) for how this was found to be a separate, silent gate)
- [ ] Privacy Policy URL live: `/privacy` ([public/privacy.html](../public/privacy.html))
- [ ] Data Deletion Instructions URL live: `/data-deletion` ([public/data-deletion.html](../public/data-deletion.html))
- [ ] Screencast recorded (script below)
- [ ] Submit

---

## Permission justifications

### `instagram_business_basic`

**What dmSlayer uses it for:** After the owner connects their Instagram professional account via
OAuth, this permission reads their basic profile (username, account type, profile picture) and
their media list. The profile info is shown in the app's sidebar and status bar; the media list
populates the "pick a post or reel" grid in the automation builder, so the owner can choose which
of their own posts a keyword-triggered automation watches.

**Justification text:**
> dmSlayer is a self-hosted tool that lets an Instagram professional account owner build
> keyword-triggered comment-to-DM automations on their own content. `instagram_business_basic` is
> used only to display the connected account's own profile (username, avatar) in the app UI, and
> to list the account's own posts/reels so the owner can select which one a given automation
> applies to. No data belonging to any other account is read with this permission.

### `instagram_business_manage_comments`

**What dmSlayer uses it for:** Polls comments on the specific post/reel a campaign is attached to,
checks each new comment's text against the campaign's configured keyword (whole-word,
case-insensitive match), and — only on a match — optionally posts a public reply and/or likes the
triggering comment, then sends a private reply with a button to open a DM with the commenter (this
is the only way to message someone who has never messaged the account before).

**Justification text:**
> dmSlayer reads comments only on media owned by the connected account, and only to detect whether
> a comment contains a keyword the account owner configured (e.g. "LINK"). On a match, it may post
> a public reply and/or like the comment, and sends a private reply to open a conversation with the
> commenter — the standard mechanism for an Instagram professional account to respond to a
> commenter who hasn't messaged them before. No comment data is read for any purpose beyond running
> the specific automation the account owner built and turned on.

### `instagram_business_manage_messages`

**What dmSlayer uses it for:** Reads inbound messages to detect a tap on the opening DM's button
(any inbound message, since the private-reply button's tap doesn't carry visible text in polling
mode), a follow confirmation, or an email reply/chip tap. Sends the opening private reply, an
optional follow-gate quick reply, an optional email-ask quick reply (Instagram's native
`user_email` chip), and the final delivery message containing the reward the account owner
configured.

**Justification text:**
> dmSlayer sends and reads Direct Messages only as part of a funnel the account owner explicitly
> built: an opening message after a matching comment, an optional "please follow" step, an optional
> email-capture step, and a final message delivering the link or reward the owner configured. No
> message content is read outside of resolving where a specific person is in that funnel, and no
> messages are sent that the account owner didn't author the copy for.

---

## Screencast script (2–3 minutes, one take, real accounts)

Record on your own deployed Worker URL with your connected Instagram account and a
second real Instagram account as the commenter.

1. **Login** — open dmSlayer, enter the owner token, land on the Automations list.
2. **Connect Instagram** (if not already connected in-frame) — show the OAuth redirect to
   Instagram's own consent screen, approving the requested permissions, and landing back on
   "Connected ✅".
3. **Build a campaign** — go to Create, pick a real post from the media grid, set keyword to a
   distinctive test word, show the opening message / follow-gate / email-ask toggles and their
   copy, set a delivery message with `{reward}`, save, and hit **Go live**.
4. **Trigger it for real** — from the second account, comment the exact keyword on that live post.
5. **Show the DM landing** — on the second account, open Instagram, show the private reply arriving
   in **Requests**, tap the button, show it move to the main inbox.
6. **Walk the funnel** — show the follow-gate prompt, tap "I followed"; show the email-ask chip,
   supply an email; show the final delivery message with the real reward link.
7. **Show the Dashboard** — back in dmSlayer, open Dashboard, show the funnel counts (Commented →
   Clicked → Followed → Gave email → Delivered) incrementing to reflect exactly what just happened.
8. **Show Contacts** — the same person's row, with their funnel status and captured email.

Keep it to one continuous take — Meta reviewers are specifically checking that the demo isn't
staged/edited.
