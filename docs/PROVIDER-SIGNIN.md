# Provider sign-in for the agent harness — spike and decision

What it takes to use a real model provider with the durable harness, and why the shipped
default is a scripted local stand-in instead. No credential was created, read, copied or
printed while writing this; everything below comes from the pinned libraries and the
existing code.

## What the pinned stack already provides

| Piece | Evidence |
|---|---|
| A real provider for OpenAI/Codex | `openaiCodexProvider()` in `@earendil-works/pi-ai/providers/openai-codex`, api `openai-codex-responses` |
| It is **subscription** OAuth, not an API key | the provider declares `auth: { oauth: lazyOAuth({ name: 'OpenAI (ChatGPT Plus/Pro)', isSubscription: true }) }` and a `https://chatgpt.com/backend-api` base URL |
| A device-code flow the app can drive | `AuthEvent` includes `{ type: 'device_code', userCode, verificationUri, intervalSeconds, expiresInSeconds }`, plus `auth_url`, `info` and `progress` events |
| App-owned login and storage | `Models.login(providerId, 'oauth', interaction)`, `Models.logout(providerId)`, and a four-method `CredentialStore` (`read`, `list`, `modify`, `delete`) that the app implements and passes to `createModels({ credentials })` |
| Refresh is handled for us | `Models.getAuth()` performs OAuth refresh inside `CredentialStore.modify`, so a rotated token cannot be double-refreshed |

## What is missing in this application

1. **A credential store.** Four methods over a file in the data root (`<data>/agents/auth.json`, 0600, one credential per provider id). Small and testable; nothing else in the application needs to know about it.
2. **A sign-in flow.** `models.login('openai-codex','oauth', interaction)` where the interaction forwards `device_code`/`auth_url` events to the interface and accepts the pasted code. Because it is a device-code flow, the owner can complete it **from the phone**; no browser is needed on the host.
3. **Provider and model selection.** `HarnessHost` currently builds a scripted provider per project and pins one model. A real provider means constructing it once with the credential store and letting a project choose a model. Contained change: one construction site, one agent-config field, one picker in the interface.
4. **Sign-in state in the interface.** "Sign in", "signed in as …", "sign in again" (expired or revoked), and what a run does when auth is missing — a clear error, never a silent fallback to the scripted provider.

Effort: about a day of focused work including tests, plus the owner's sign-in and a
billing decision. The pieces are all present; nothing needs to be invented.

## Risks and honest limitations

- **Billing is the owner's decision, not a technical detail.** This provider path is a subscription credential against a consumer backend (`isSubscription: true`). The coding agent itself warns for a comparable case that "third-party harness usage draws from extra usage and is billed per token, not your plan limits". Whether that is acceptable, and whether it is within the provider's terms, is not something this application can decide.
- **Unattended agents spend quota.** The harness resumes runs, retries, and can be driven by scheduled work; once a real provider is wired in, the free-and-deterministic property is gone. A spend or usage cap and a stop switch would need to come with it.
- **Credential custody in a container.** The token would live in the data directory (0600, never logged, never printed). The backup script deliberately copies no credentials, so a restore needs a fresh sign-in. That is the right default, and it must be stated.
- **A single-owner application is not multi-tenant.** One credential per provider, one owner; no per-project isolation of the provider account.
- **The scripted provider should stay the default.** It is what makes the tests deterministic and the application free to run. Real sign-in has to be an explicit, per-instance opt-in, and turning it off must be as easy as turning it on.
- **Provider availability and rate limits** are outside our control; a quota or outage shows up as a failed run, which the alerting already reports as an error event.

## Decision

**A real provider is not wired in.** Everything else works without one, and adopting it
would end the free, deterministic property that makes the whole path testable.

When the owner wants real model calls, the sequence is:

1. Choose the credential: OpenAI/Codex subscription sign-in (the adapter described above), a direct API key in the container's environment, or OpenRouter (the reference implementation's choice).
2. Agree a usage cap and who watches it, and state the billing/terms position in writing.
3. Implement the credential store, the device-code sign-in flow, provider selection and the sign-in states, with tests that use a stubbed interaction and never a real credential.
4. Prove it on a disposable project first, then decide whether the default provider changes.

If instead the owner prefers not to use a subscription credential, the smallest honest
alternative is a direct API key held in the container's environment (never in the image, never
in a backup) — the same code path minus the OAuth interaction.
