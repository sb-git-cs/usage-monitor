# Phone account connections

Android shows **Claude Code, Codex, Gemini, Grok Build and Cursor**. Copilot is metered
only on the computer.

## Where each meter reads from

Each tool uses the first of these that applies:

1. **Phone**: a sign-in made on this phone (Accounts → Sign in). Always used while it works.
2. **Computer**: the paired computer's reading, while it is current (under 30 minutes old
   and the last fetch succeeded).
3. **Direct**: this phone reads the tool's usage itself with the computer's linked access
   token (Accounts → Link sign-ins), while the computer's reading is not current.
4. Otherwise the newest reading, marked cached with its age.

Home tags Direct and Phone readings; the header names the computer. The widgets, alerts and
the Accounts tab use the same readings. Direct reads are spaced at least 2 minutes apart per
tool (Refresh skips the spacing) and back off 15 minutes after a rate limit.

## Computer link

**Link sign-ins** sends `POST /v1/link`; the computer asks **Allow / Cancel**. Once allowed,
the phone fetches `GET /v1/tokens` at most every 10 minutes while it can reach the computer
(see `phone-protocol.md`). Only current access tokens are sent; refresh tokens stay on the
computer, so the phone never rotates a command-line sign-in. Each token works until it
expires: Claude about 8 hours, Gemini 1 hour, Grok 6 hours, Codex 10 days, Cursor 60 days.
**Stop direct reading** (phone or computer Settings → Phone), forgetting the computer, or
pairing another computer drops the linked tokens.

## Signing in on the phone

| Tool | How | Renewal |
| --- | --- | --- |
| Claude Code | Browser sign-in at claude.com; paste back the code the page shows. Requests only the `user:profile` scope. | Refresh token, 5 minutes before expiry |
| Codex | Device code at auth.openai.com/codex/device. ChatGPT may require device code sign-in to be enabled in its security settings. | Refresh token, a day before expiry |
| Grok Build | Device code (RFC 8628) at auth.x.ai with the Grok Build command line's public client. | Refresh token, 5 minutes before expiry |
| Cursor | Browser approval at cursor.com while the phone waits. | None; sign in again after 60 days |
| Gemini | Not offered: Google sign-in needs the Antigravity client secret, which is not sent to the phone. Use the computer link. | — |

Each flow mirrors the tool's own command-line sign-in (endpoints and client IDs confirmed
against the installed CLIs on 2026-10-01). The Codex and Grok device codes were issued by the
live services on the test phone; completing a sign-in and reading usage with it still needs
the account owner's approval on each provider. These are the tools' own sign-ins used from a
different app; Anthropic's and Google's terms restrict third-party use of subscription
sign-ins, and the owner chose to accept that.

Phone sign-ins and linked tokens are kept in `noBackupFilesDir/sign-ins`, encrypted with
AES-GCM under an Android Keystore key. Readings (no tokens) are cached in the settings file
for the widgets. Signing out on the phone affects only the phone.

## Recovery and widget status (2026-10-02)

Sign-in checks the first usage response before reporting **Connected**. When authorization
works but usage is temporarily unavailable or empty, it saves the sign-in and explains
that usage is pending. Accounts shows the reading's status and error, with **Retry sign-in**
available for a saved phone account. Claude accepts the displayed code, code with state,
or its callback URL; submitting it shows progress and cancelling cannot complete an old request.

Foreground and background refreshes are serialized to avoid rotating a refresh token twice.
Network failures, service errors and HTTP 403 preserve the saved authorization. Only a
confirmed expired/revoked grant or an unauthorized usage response after renewal removes it.
Nonrenewable tokens remain usable until their actual expiry. Phone account names and plans
are never filled from a different computer account.

The first usage result is saved and widgets are refreshed independently of the Accounts
screen. Signing out, stopping the computer link, and revoked linked access clear the affected
cached readings. Compact widgets retain cached percentages with an **Old** label, prioritize
current readings, and display **Sign in** or **Retry** for authentication and fetch errors.
Large widgets use the displayed readings' age and hide cached computer hardware readings.
Cached text values and forecast information are preserved alongside numeric windows.
