# Providers, sign-in and model preferences

Providers are managed from **Providers & models** (the gear in the app header).
No shell or environment-file edit is needed.

## Supported connections

- OpenAI, Anthropic, Google and OpenRouter API-key connections.
- **Sign in with ChatGPT** and **OpenAI Codex (legacy)** can store credentials, but their current
  generation transports omit the output bound and are refused. A successful sign-in does not mean
  these models can run. Use a supported API-key transport instead.

These use the pinned Pi AI 1.3.0 adapters and bundled chat-model catalog. Custom
provider endpoints and arbitrary provider plugins are not supported by this UI.
Saving an API key records it; it does not verify it with a billed test request.
Availability in the bundled catalog does not guarantee account entitlement.

## Sign in from a phone

These sign-in flows are retained for credential management, but currently cannot be used for model
generation because their transport does not provide a verifiable output cap. The OpenAI provider uses a browser/PKCE flow. Complete sign-in in a new
tab. Its final callback is a localhost URL; on a phone it will not reach the
server. Copy that full URL from the address bar into Pilot's waiting sign-in
prompt. The library validates the callback and exchanges the code on the server.
Do not paste callback URLs or codes into chat.

Sign-in jobs expire after 15 minutes, can be cancelled, and their URLs/codes live
only in memory. Closing the settings dialog cancels a pending job. A backend
restart requires starting the login again. The callback listener is loopback-only
and is not published by the container or tunnel.

## Credentials and refresh

Credentials are app-owned, at `<data>/credentials/providers.json`, mode 0600,
inside a 0700 directory. The instance's stable OAuth device identifier is stored
separately under `settings/installation.json`.

The credential store serializes every read-modify-write across providers,
including refresh and logout; the app's service lock excludes a second process.
Pi AI resolves request auth and refreshes OAuth under that same store queue.

GET settings responses expose connection status and credential **type**, never
API keys, access tokens or refresh tokens. Login polling returns only the
temporary interaction needed by the owner. Errors from login are generic rather
than echoing provider token-response bodies.

Storage is **not encrypted at rest**. The application user and host root can
read it. Shell-capable code in the same container could read it as well; there is
no per-agent credential sandbox. The current agent tools are question and note
operations, not general coding tools.

Ordinary backups exclude credentials. Restore requires reconnecting providers.
Disconnecting a provider removes Pilot's local credential, not the provider's
remote grant: revoke it at the provider too when needed.

## Defaults and favourites

- Star models to move them to the top of settings and the session-model picker.
- The global default applies to **new sessions**, not already-open conversations.
- Each project's Agents view has a **Session model** picker. Model changes are
  persisted in that conversation and require it to be idle.
- The scripted provider remains the initial default and can be selected again.
- Unknown models, missing credentials and disabled real calls fail explicitly.
  There is no silent fallback to a different paid model or to scripted replies.

## Calls and billing

**Allow real model calls** is off by default. Adding credentials, signing in,
choosing a default or starring models makes no model call. Enabling this switch
authorizes calls submitted by the owner and continuation of unfinished runs.

Model dispatch checks that switch and provider availability on every request,
including queued work and resumed checkpoints. Current limits:

- Ordinary sessions use the configurable instance output and turn limits (defaults: 32,000 output
  tokens per request and 40 turns after the latest input). A zero turn limit is unlimited.
- Owner-created workers have separate limits of at most 4,096 requested output tokens per request and
  eight model requests per run; lower instance limits still apply.
- Supported locked adapters' outgoing payloads must carry a verifiable output bound. Missing or inflated
  bounds and uncheckable transports are refused; providers must honor the requested value.
- Adapter retries and a second fallback payload are disabled; automatic compaction is disabled.

These are **not a monetary cap**. Input tokens, provider pricing, failed calls
and subscription rules still matter; provider-side budgets are recommended.
Turning the switch off prevents the next dispatch, but does not recall a request
already in flight. Use **Stop** to interrupt the session.
`DASHBOARD_AGENTS=off` disables the harness instance-wide after configuration is
applied.

The owner must check their provider's current terms, quota and billing rules.
No promise is made that third-party harness use is included in a subscription.

## Verification

Automated tests use disposable roots, fake credentials and synthetic providers:
credential persistence/permissions, concurrent refresh and logout, one-use login
prompts/cancellation, default/favourite sorting, actual harness model dispatch,
dispatch opt-in and the configured turn limit. Browser tests exercise key entry and
persisted model preferences without contacting a model.

These tests are **not** a live provider sign-in or billed generation acceptance.
The owner completes real sign-in and a small intentional test separately.
