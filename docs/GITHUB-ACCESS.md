# GitHub access: broker-issued, App-scoped, never a user credential

Pilot needs to read and occasionally propose changes to GitHub repositories. It must be able to do
that **without ever holding a credential that acts as a person**, and without the ability to
alter the workflows that consume secrets.

This document defines the boundary. See `GITHUB-PUSH-FEASIBILITY.md` for the commit/push transport
analysis and `AGENTS.md` for the agent/scope model this plugs into.

## Why this exists

On 2026-11-19 an attacker pushed `on: push` workflow files into seven repositories, read repository
secrets from the runs, and pivoted into the hosting platform. The push credential was attributed to
the human account and was **never identified**. Two properties made it possible and are what this
design removes:

1. the credential could modify `.github/workflows/**`, so a run could be made to consume secrets;
2. the credential was user-scoped, so every action was indistinguishable from the owner's.

A broker-issued GitHub App token fixes both: the actor is `pilot-agent[bot]`, and `workflows` is
not among the grants.

## The three identities

| Identity | Who acts | What it may do | What it must never do |
|---|---|---|---|
| **Owner** | the human | anything | be handed to Pilot, a container, or a `.env` |
| **Broker** | service on the host/tailnet | hold the App private key; mint installation tokens; perform allowlisted operations | expose the private key, or mint a token outside the allowlist |
| **Pilot** | the harness | request a token for one repo + one operation; use it until expiry | store a token at rest, request broad scope, or push to a protected ref |

Pilot never sees the private key. The worst a compromised harness can obtain is a one-hour token
for one repository with a permission set that cannot alter workflows.

## Grants

Constrained by the 19 Nov incident and by review of what `contents: write` actually permits:

| Permission | Grant | Reason |
|---|---|---|
| `contents` | **read** | reading code, diffs, trees |
| `contents` | write — **denied by default** | write is not branch-scoped: it can alter build scripts, composite actions and deployment definitions that unchanged CI executes, and can move refs to existing commits. Enable only if a concrete need is proven, and then only on a fork the broker controls |
| `pull_requests` | **write** | open and update PRs |
| `actions` | read — only if required | logs and artifacts can contain recoverable incident material |
| `workflows` | **never** | the single permission that made 19 Nov possible |
| `administration`, `secrets`, `deploy keys`, `environments`, `actions: write`, `packages`, org/account rights | **never** | unrelated to Pilot's purpose |

Installation scope: **selected repositories only**, never "all repositories". The broker narrows
every issuance further to the one repo named in the request — an installation token is otherwise
valid for every repository in the installation.

The App must not be an approver of its own work: it may open PRs and reviews are welcome, but a
human approval remains required on protected refs.

## Broker contract

Pilot makes one call and receives one short-lived token, or a refusal.

```
POST /v1/token
  { "repo": "goodjobdev/pilot", "operation": "read" | "propose" }
  → 200 { "token": "ghs_…", "expires_at": "…", "repo": "…", "permissions": { … } }
  → 403 { "refused": "repo not in allowlist" | "operation not permitted" | "rate limited" }
```

Rules the broker enforces, each of which is a refusal rather than a reduction:

- Repo not on the allowlist → refuse. The allowlist is explicit and closed, like the agent scope
  vocabulary; it is never widened implicitly.
- `operation: propose` with no upstream write grant configured → refuse, and say so.
- Token already issued for that repo and operation within its lifetime → return the existing one
  rather than minting a second.
- Rate limits per agent, per repo, per hour.
- Every issuance and refusal is appended to an audit log **off the harness host**, with the
  requesting workload identity, repo, operation and outcome — never the token.

Prefer, where practical, to have the broker **perform the operation** and return its result rather
than a bearer token. A returned token can be exfiltrated by anything in the harness; a DNS record
or a PR comment created by the broker cannot.

Identity: the broker authenticates the caller by workload identity (tailnet node identity plus a
per-agent credential), not by network position alone. A tailnet listener that trusts any tailnet
peer is not authentication.

## Pilot's obligations

- Treat any token as ephemeral: never write it to disk, a log, a prompt transcript, an artifact,
  or an environment dump. The 19 Nov payload harvested `secret_name=value` pairs from `env`.
- Request the narrowest operation that accomplishes the task; do not batch unrelated repos.
- On refusal, stop and report. Never retry with a broader request, a different repo, or an
  inherited credential.
- Never use `git` with an inherited credential from the host. If `GIT_ASKPASS`, a credential
  helper, or an SSH agent is present in the environment, that is a bug — report it.
- `contents: write`, if ever granted, is for a **branch**, not for `main` or a release ref.

## Verification required before this is trusted

Positive, negative, expiry and revocation tests, in a disposable repository with no secrets:

1. Token reads a file in an allowlisted repo → succeeds.
2. Token writes `.github/workflows/*` → **denied** (fresh file, and an existing file's content).
3. Token touches a repo outside the allowlist → **denied**.
4. Token after expiry → **denied**.
5. Token after broker revocation → **denied**.
6. Broker refuses an unlisted repo → 403, audited.
7. Prompt containing a token-shaped string in a log/artifact → redacted or refused.

Also confirm: branch **and tag** protection on release refs, no App bypass, environment-scoped
secrets so a side-branch `push` run cannot read production secrets, pinned third-party actions, and
no `pull_request_target` executing PR-head code.

## Open decisions

1. Fork-based submission vs. upstream `contents: write`. The former keeps the App unprivileged; the
   latter makes the broker a privileged component that must be treated as such. Default: fork.
2. Where the broker runs. Same-host is convenient but is not a boundary against host root; a
   separate trusted host is stronger. Coolify must not manage it, since Coolify can act as host root.
3. Whether `actions: read` is genuinely needed, given that logs may contain incident material.
