# Deploying Pilot

Pilot is a single-owner application. It assumes a private host you control, a hostname you
own, and one person allowed through the door. Do not expose it directly to the internet:
put an authenticating proxy in front of it (the examples here use Cloudflare Access) or keep
it on a private network you trust.

## Requirements

- Node 22+ (24 tested), pnpm, git.
- A host that stays on, with a persistent data directory.
- A hostname you control, and an identity provider that can allow exactly one person.

## Local development

```sh
pnpm install
pnpm check && pnpm test && pnpm build
DASHBOARD_MODE=local DASHBOARD_DATA=/tmp/pilot-data PORT=4317 pnpm start
```

Local mode prints a session token into the page it serves, checks it on every API call, and
requires the same origin and a JSON content type for writes. It exists for localhost only —
never tunnel it. Rebuild after source edits; `pnpm dev` is a client-only preview.

## Hosted deployment

Hosted mode is the only mode that verifies an identity, and it fails closed: if any of its
configuration is missing the process refuses to start.

1. **Stage a release.** Keep immutable releases and a `current` symlink beside them, with
   production dependencies installed from the frozen lockfile. Build in the release
   directory, not in a parent project.
2. **Create the data directory and environment file** (0600) from `.env.example`. Hosted
   mode requires `DASHBOARD_ORIGIN`, `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` and
   `DASHBOARD_OWNER`; unset values are a fatal startup error.
3. **Create the access application first.** A self-hosted application for the hostname, with
   a single Allow policy for your email — no Bypass, no Everyone, no service tokens. Use a
   `lax` cookie: with `strict` the cookie is not sent on the cross-site redirect back from
   the login page and you get a login loop.
4. **Route it through a dedicated tunnel** (or any authenticating proxy) to
   `http://127.0.0.1:4317`, with the expected public Host header and a catch-all 404. Create
   the access policy before routing.
5. **Install the user units** from `deploy/`, adjusting the Node path and the release
   directory. `deploy/pilot-tunnel.service.example` shows the tunnel unit. Enable lingering
   only if you want the services to survive logout.

### Verify before you trust it

| Check | Expected |
|---|---|
| `curl -H 'Host: your.host' http://127.0.0.1:4317/healthz` | `200` |
| The same request with no identity | `401` |
| The same request with a forged assertion header | `401` — the application verifies signatures itself |
| Any request with the wrong Host | `403` |
| `https://your.host/` from outside | `302` to your identity provider |
| A non-owner who signs in | refused by the access policy |

Health exposes no planning data, and every other route needs the owner's identity.

## The container variant

`deploy/pilot/` defines one capped container: non-root user, read-only root filesystem,
all capabilities dropped, `no-new-privileges`, its own bridge network, no Docker socket, no
host networking, CPU/memory/PID limits and rotated logs. It publishes on loopback only, and
a second service in the same compose project runs the tunnel so the application never needs a
public port. Keep the environment file beside the compose file (it is excluded from the build
context) and mount a named volume at `/data`.

## Backup and restore

Backups take an exclusive lock, so the application must be stopped first.

```sh
docker compose --env-file .env stop dashboard
node scripts/backup.mjs /path/to/data /path/to/new-backup-directory
node scripts/restore.mjs /path/to/backup /path/to/new-isolated-data-root
docker compose --env-file .env start dashboard
```

- The backup contains the catalog, every managed project's board **and documentation**, and
  the board and source snapshots of external projects, whose repository is their own backup.
- It contains **no** credentials, **no** agent session databases and **no** alert keys or
  subscriptions. A restore therefore needs a fresh sign-in and re-enabling alerts on each
  device.
- Symlinks fail closed, every file is hashed, and a restore verifies each hash before writing.
  Restore never overwrites an existing root and remaps project paths to new workspaces.
- Test a restore into an isolated root and compare bytes before trusting a backup. Copy
  completed backups somewhere else as well: same-disk snapshots are not a backup.

## Upgrades and rollback

Stop only the application, let it drain, and check that `service.lock` is gone before
switching releases. Point `current` at the new release, start, and verify health and the
deny cases above. Roll back build artefacts only — never replace newer boards or documents
with older ones.

## Operational notes

Provider credentials and model preferences are configured through **Providers & models**.
Project deploy keys and review worktrees are configured through **Board actions → Repository
& deploy key**. See [Provider sign-in](PROVIDER-SIGNIN.md) and
[Project connections](PROJECT-CONNECTIONS.md) for storage, revocation and backup limitations.
The container includes Git and OpenSSH for fixed provisioning only; it still has no general
coding tools. These features do not change the Access application or tunnel policy.


- **A restart rotates the CSRF secret.** The client renews its same-origin session and retries
  once only for the explicit `SESSION_CSRF` rejection, which occurs before any mutation.
  Generic permission errors, network failures and conflicts are not retried. Old clients need
  one reload to pick up this behaviour.
- **An unclean kill leaves `service.lock`.** Startup fails closed until an operator confirms
  no writer remains and removes that lock. With `restart: unless-stopped` this looks like a
  crash-loop, so check the log for the lock message before assuming a code fault.
- **Request logging is method, path and status only** — no query strings, headers or bodies.
- **Alert keys live in the data directory** (`alerts/vapid.json`, 0600). Rotating them
  invalidates every subscription.
