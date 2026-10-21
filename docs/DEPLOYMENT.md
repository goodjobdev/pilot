# Deploying Pilot

Pilot is a single-owner application. It assumes a private host you control, a hostname you
own, and one person allowed through the door. Do not expose it directly to the internet:
put an authenticating proxy in front of it (the examples here use Cloudflare Access) or keep
it on a private network you trust.

## Requirements

- Node 24+ (26 tested), pnpm, git. Startup hard-imports `node:sqlite` for the durable control
  store, and 24 is the first major where that module is unflagged; an older runtime fails at import.
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
2. **Write the release manifest.** Every release carries its identity in `release.json` beside
   the built server (the default for `DASHBOARD_RELEASE_MANIFEST`), because hosted mode refuses
   to start without one and no later step creates it. The minimum for this build is:

   ```json
   {
     "version": "0.1.0",
     "releaseId": "release-2026-01-01",
     "schemaId": "pilot-state-1",
     "createdAt": "2026-01-01T00:00:00.000Z"
   }
   ```

   Check it with `node dist/server.mjs --doctor` before starting: `"release": {"status":
   "present"}` and exit `0` mean nothing unsafe and nothing that blocks the next start.
3. **Create the data directory and environment file** (0600) from `.env.example`. Hosted
   mode requires `DASHBOARD_ORIGIN`, `CF_ACCESS_TEAM`, `CF_ACCESS_AUD` and
   `DASHBOARD_OWNER`; unset values are a fatal startup error. Mode, exposure, bind and
   allowed Host are validated together — see
   [Startup configuration and the service lock](#startup-configuration-and-the-service-lock).
   The bundled `deploy/pilot/env.hosted.example` does not start verbatim: replace its
   `CF_ACCESS_TEAM` placeholder (`https://<team>.cloudflareaccess.com`) with the real Access
   team subdomain — letters, digits and hyphens only, as in
   `https://myteam.cloudflareaccess.com` — and its origin/hostname with your own before the
   process validates it.
4. **Create the access application first.** A self-hosted application for the hostname, with
   a single Allow policy for your email — no Bypass, no Everyone, no service tokens. Use a
   `lax` cookie: with `strict` the cookie is not sent on the cross-site redirect back from
   the login page and you get a login loop.
5. **Route it through a dedicated tunnel** (or any authenticating proxy) to
   `http://127.0.0.1:4317`, with the expected public Host header and a catch-all 404. Create
   the access policy before routing.
6. **Install the user units** from `deploy/`, adjusting the Node path and the release
   directory. `deploy/pilot-tunnel.service.example` shows the tunnel unit. If you want the user
   services to keep running after you log out, an operator must enable lingering once
   (`loginctl enable-linger <user>`). This is a host step: the application neither runs nor
   changes any systemd state.

### Verify before you trust it

| Check | Expected |
|---|---|
| `curl -H 'Host: your.host' http://127.0.0.1:4317/healthz` | `200` |
| The same request with no identity | `401` |
| The same request with a forged assertion header | `401` — the application verifies signatures itself |
| Any request with the wrong Host | `403` |
| `https://your.host/` from outside | `302` to your identity provider |
| A non-owner who signs in | refused by the access policy |
| `curl -H 'Host: your.host' http://127.0.0.1:4317/readyz` with no identity | `401` — readiness is authenticated, unlike liveness |
| The same with the owner's identity when every check passes | `200` with `{"ok":true,…}` |
| The same with the owner's identity but an unmet condition | `503` with the machine-readable `reasons` |

`/healthz` is unauthenticated liveness: it only says the process is responding and exposes no
planning data. `/readyz` is authenticated expected-version readiness (see
[Release identity and readiness](#release-identity-and-readiness)) and reports app-known facts
only. Every other route needs the owner's identity.

## Startup configuration and the service lock

Every startup value is validated before the data root is touched and before any store is
opened. An invalid or contradictory combination stops the process with a non-zero exit and a
message naming the problem; nothing is created and nothing listens.

| Variable | Effect |
|---|---|
| `DASHBOARD_MODE` | Required. `local` (loopback, session token in the page) or `hosted` (Cloudflare Access). |
| `DASHBOARD_EXPOSURE` | `host-loopback` (default) or `container-private-interface`. The second is the only way to bind an interface other than loopback. |
| `DASHBOARD_BIND` | Canonical IPv4 literal. `host-loopback` requires `127.0.0.1`; `container-private-interface` requires hosted mode and `0.0.0.0`. |
| `DASHBOARD_ALLOWED_HOSTS` | Optional. If set it must be exactly the canonical origin host. The accepted Host set is never widened beyond that host. |
| `DASHBOARD_RELEASE` | Optional release identity recorded in the lock, bounded to 1-120 characters of `A-Za-z0-9._:-`. Defaults to `unreleased-local`; a release manifest overrides it. |
| `DASHBOARD_RELEASE_MANIFEST` | Optional path to the immutable release manifest. Defaults to `release.json` beside the built server. See [Release identity and readiness](#release-identity-and-readiness). |
| `DASHBOARD_ROOT_ID` | Optional logical root id recorded in the lock, bounded the same way. Defaults to the first 16 hex characters of sha256 of the canonical data root path. |
| `DASHBOARD_SHUTDOWN_DEADLINE_MS` | Optional. How long one drain may take, 1-60000; 10000 by default. Reaching it retains the lock. |
| `PORT`, `DASHBOARD_DATA`, `DASHBOARD_ROOTS` | Listen port (4317 by default), data root, and approved roots. |

`DASHBOARD_RELEASE`, `DASHBOARD_ROOT_ID` and `DASHBOARD_SHUTDOWN_DEADLINE_MS` are not part of
the effective configuration, but the entrypoint bounds them with the same fail-closed rule
before it touches the data root: both lock identity values are durable evidence and are
therefore restricted to that opaque-token alphabet instead of being recorded verbatim.

Local mode rejects the hosted identity variables (`DASHBOARD_ORIGIN`, `CF_ACCESS_TEAM`,
`CF_ACCESS_AUD`, `DASHBOARD_OWNER`) instead of ignoring them. The process validates the
listener literal, the canonical origin and the accepted Host; whether the surrounding network
actually restricts access stays an **operator-attested** fact, not something inferred from
the listener or from the proxy in front of it.

### The service lock

Before opening stores or listening, the process creates the data root if missing (0700) and
takes an exclusive lock at `<data root>/service.lock` (0600, a version-1 JSON record). That
lock is the single authority for owning a data root.

- **A held lock fails closed.** Any existing lock evidence blocks startup: the process writes
  one diagnostic naming the lock path and stating that no automatic recovery is performed,
  then exits non-zero. It never deletes, renames, truncates or rewrites the evidence, and it
  never creates a second lock.
- **Clearing a stale lock is a deliberate operator action.** There is no automatic recovery
  and no age- or PID-based takeover. After a kill that left the lock: stop the supervisor so
  nothing can restart the service (`systemctl --user stop pilot`, `docker compose stop
  dashboard`), confirm no Pilot process remains (`pgrep -fl server.mjs`), keep a copy of the
  record if you want the evidence, remove exactly that file
  (`rm '<data root>/service.lock'`), and start the service again.
- **Shutdown is bounded.** On the first `SIGTERM` or `SIGINT` the process closes the
  application and then releases the lock; later signals are ignored while it drains. If the
  close does not finish within `DASHBOARD_SHUTDOWN_DEADLINE_MS` (10 seconds by default), it
  logs that the lock is intentionally retained, exits non-zero and leaves the lock in place, so
  the next start fails closed instead of racing a half-closed writer. Only a close that fails or
  overruns that deadline retains the lock: a start that never listened — the port is already in
  use, for example — still closes and releases the lock **it created**, then exits non-zero with
  the original bind error, so a failed start cannot strand a data root.
- **The lock is cooperative, not hostile isolation.** It is a filename-based exclusive-create
  record for cooperating processes. Another process with the same filesystem permissions — in
  particular a same-UID shell — can ignore or remove it. It stops a second Pilot from starting
  on the same data root; it is not a security boundary against an adversary.

## Release identity and readiness

An immutable release manifest describes the running build. It is a strict JSON object with no
unknown fields, read from `DASHBOARD_RELEASE_MANIFEST` or, by default, `release.json` beside the
built server inside the release directory:

```json
{
  "version": "0.1.0",
  "releaseId": "release-2026-01-01",
  "schemaId": "pilot-state-1",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "sourceDigest": "0123456789abcdef0123456789abcdef01234567"
}
```

- `version` is the build version; `releaseId` and `schemaId` become the service lock's recorded
  identity. `sourceDigest` (a source revision) and `buildId` (an opaque build id) are optional.
- Unknown fields, missing required fields, malformed ids or timestamps, absolute-path or traversal
  values and an unsupported `schemaId` all fail closed with a clear message. `pilot-state-1` is the
  only supported schema id today.
- **Hosted mode refuses to start without a valid manifest.** Local mode may run without one and
  reports the explicit `unreleased-local` identity; an invalid manifest fails closed in both modes.
- With a manifest present, its `releaseId`/`schemaId` are what the lock records; without one, the
  bounded `DASHBOARD_RELEASE` and `pilot-state-1` remain the identity (`DASHBOARD_ROOT_ID` is
  unchanged in both cases).

### Readiness versus liveness

`/healthz` is unauthenticated liveness and never changes: it only says the process is responding.
`/readyz` is authenticated expected-version readiness behind the same owner-only authorization and
Host check as every other route. It returns `200` only when the stores are open, this process holds
the service lock, the release manifest is valid, the data root is writable, and the storage schema
matches the expected `schemaId`; otherwise it returns `503` with a machine-readable `reasons` list.

The schema it reports is not re-read from disk: startup opens the durable control store
(`<data root>/control.sqlite`, created 0600 with its schema on a fresh root, before anything
listens) and readiness asks that live handle. A start that cannot open the store, or whose schema is
not the `schemaId` the release names, refuses to serve rather than answering `503` forever. The
reported facts are `releaseId`, `schemaId`, `lockHeld`, `dataRootWritable` and `reasons` — never a
filesystem path or secret. The reasons are `release-manifest-invalid`, `service-lock-not-held`,
`data-root-not-writable`, `storage-schema-absent`, `storage-schema-unreadable`,
`storage-schema-busy` (a live writer held the file) and `storage-schema-mismatch`. Readiness is
read-only and takes no lock.

A supervisor should gate on readiness rather than liveness: a responding process that cannot hold
its lock or match its expected schema is not ready to serve. Health checks stay cheap and
unauthenticated; a readiness probe carries the owner's identity.

### The read-only doctor

`node dist/server.mjs --doctor` is the only diagnostics command. It acquires nothing, mutates
nothing and starts no server, and states so in its output. It reports the configured mode,
exposure, bind and exact allowed Host (printing a clear diagnostic instead of crashing when the
configuration is invalid), the canonical data root and its permissions, the service-lock inspection
(`absent`/`active`/`proven-dead`/`ambiguous`) with its recorded metadata, the storage schema version
actually found (read-only), the release manifest's validity (including a manifest path it cannot
even resolve), and whether a server appears to be running.

Its exit code covers two separate questions:

- `0` — no unsafe condition **and** nothing that blocks the next start.
- non-zero — otherwise. Either `unsafe` is `true` (malformed, foreign or untrusted lock evidence, an
  unsupported or unreadable storage schema, an invalid manifest, a missing hosted manifest, or an
  invalid configuration) or `startBlockers` is non-empty.

`startBlockers` names conditions that are not unsafe by themselves but would make the next start
fail closed:

| Blocker | Meaning |
|---|---|
| `service-lock-present` | A well-formed lock for this root exists and its recorded process is not classifiable — the ordinary case for evidence left by a crash. Any existing lock blocks acquisition. |
| `service-lock-active` | A lock for this root whose recorded process is verifiably running. |
| `service-lock-proven-dead` | A lock for this root whose recorded process is proven dead. Still blocks: there is no automatic recovery. |
| `restore-not-promoted` | The root carries `RESTORE-PAUSED.json`, so it is a restored root an operator has not promoted yet. A deliberate pause is a blocker, not corruption: `unsafe` stays `false`. See [Backup, restore and promotion](#backup-restore-and-promotion). |
| `port-in-use` | Something accepts connections on the configured endpoint, so the next bind would fail. |

A healthy root reports `"startBlockers": []`. Running the doctor against a live instance legitimately
reports `service-lock-present` (or `service-lock-active`) and `port-in-use`: that is the diagnosis,
not a fault. The doctor never deletes, renames, rewrites or takes the lock.

### Approvals and interrupted deliveries

Two pieces of persisted state change what an operator should expect after a restart. Both live in
`control.sqlite`, and neither performs an action on your behalf.

- **Approvals.** A consequential action is authorised by an explicit, single-use, target-bound
  approval: created with `POST /api/approvals`, consumed exactly once with
  `POST /api/approvals/:id/consume`, revoked with `POST /api/approvals/:id/revoke` — all behind
  the same owner-only authentication, session CSRF, origin and Host checks as every other route. An
  approval binds one **exact target** for its kind (remote, branch and commit sha for a push; amount
  and currency for a spend; endpoint and release id for a deploy; and so on), names a scope (project,
  session and/or operation) that every read and consumption must match exactly, and expires within a
  documented maximum of **60 minutes**. Consuming records what consumed it and returns the exact
  target; **it performs no commit, push, deploy, spend, provision or publish.** Single use is
  enforced by the control store's own checked transaction, so a consumed approval stays consumed
  across a restart and a replay — including after a crash — is refused, as are expired, revoked,
  foreign-scope and wrong-target attempts. See [Approvals](APPROVALS.md).
- **Interrupted deliveries.** A question or answer that was admitted but not acknowledged is
  re-examined read-only at every start. A single `Delivery reconciliation:` line reports only when
  there is something to report: an entry marked `redeliver-idempotent` may be re-sent because the
  delivery is tagged by question id and a repeat collapses onto the same notification, an entry
  marked `complete-acknowledgement` only needs the repeat `markDelivered` call, and anything whose
  effect is uncertain is listed as `needs-operator-attention`. Nothing is replayed automatically; a
  start that cannot reconcile reports it on stderr and keeps serving.
- With no control store open the approval routes answer `503` rather than guessing at a scope, and
  there is no unscoped view: an approval scoped to a project is never reachable through a
  session-only query.

## The container variant

`deploy/pilot/` defines one capped container: non-root user, read-only root filesystem,
all capabilities dropped, `no-new-privileges`, its own bridge network, no Docker socket, no
host networking, CPU/memory/PID limits and rotated logs. It publishes on loopback only, and
a second service in the same compose project runs the tunnel so the application never needs a
public port. Keep the environment file beside the compose file (it is excluded from the build
context) and mount a named volume at `/data`.

Inside its network namespace the container must bind `0.0.0.0`, which the exposure policy
allows only in hosted mode: `DASHBOARD_MODE=hosted`,
`DASHBOARD_EXPOSURE=container-private-interface`, `DASHBOARD_BIND=0.0.0.0`. The host still
publishes on `127.0.0.1` only. A published port reaches the container's own interface, never
its loopback, so **local mode is host-loopback only**: it runs the application on the host,
rejects the hosted identity variables and requires `DASHBOARD_BIND=127.0.0.1`. A container
must use hosted mode with `container-private-interface`; a local-mode listener inside a
container would bind a loopback the published port cannot reach. The bundled examples match
that split: `deploy/pilot/env.hosted.example` is the container profile (it sets the exposure
to `container-private-interface`) and `deploy/pilot/env.local.example` is a valid
host-loopback profile with no hosted identity variables and no `0.0.0.0` bind.

## Backup, restore and promotion

A backup is one passphrase-encrypted archive of the complete application state under the data root.
**Backup** takes the same `service.lock` startup takes, so the application must be stopped first;
**restore** and **promotion** take no lock at all, they only refuse a root that carries lock
evidence. None of the three ever clears lock evidence for you.

```sh
docker compose --env-file .env stop dashboard

# The passphrase comes from the environment or stdin, never from the command line.
export PILOT_BACKUP_PASSPHRASE='…'          # 12 characters or more, or use
                                            # PILOT_BACKUP_PASSPHRASE_STDIN=1 and pipe one line

node scripts/backup.mjs /data /srv/pilot-backups/pilot-$(date +%F).pbkp

# Check an archive before you rely on it: this authenticates it and checks every payload digest, and
# writes nothing at all - no staging directory, no destination, no lock.
node scripts/data-tools.mjs verify /srv/pilot-backups/pilot-2026-01-01.pbkp

node scripts/restore.mjs /srv/pilot-backups/pilot-2026-01-01.pbkp /srv/pilot-restore
node scripts/data-tools.mjs promote /srv/pilot-restore

docker compose --env-file .env start dashboard
```

- **Captured:** the catalog and every managed project's board **and documentation and media**, the
  board and source snapshots of external projects (the repository is its own backup), the immutable
  image media store (`media/<sha256>.bin`, one object per accepted image — without it a restore would
  lose every stored image), the agent session databases, and the durable control store — operations
  and receipts, the outbox, approvals, named sessions and their lifecycle — plus `settings/`.
- **Excluded, with a reason in every manifest:** `credentials/` (provider keys, sign-ins and project
  deploy keys — there is **no opt-in** to include them), `alerts/` (the VAPID signing key and the
  device endpoints that belong to it), `repositories/` (derived git worktrees), `service.lock` and
  `snapshots/` (the bounded board revision history the application writes itself: derived from the
  boards that *are* captured, and rebuilt as boards are edited). An unrecognised data-root entry is
  reported as excluded rather than copied blindly; `snapshots/` is named with its own reason rather
  than reported as an entry this tool failed to recognise.
- **A restored root has no credentials.** Sign in again under **Providers & models**, generate new
  project deploy keys and add their public keys at the provider, and enable alerts again on each
  device.
- **Databases are copied through SQLite** (`VACUUM INTO`, read-only), not by copying the file: the
  store runs in WAL mode, so a byte copy can miss committed rows that are still in the `-wal`
  sidecar.
- **A restore verifies before it writes.** It refuses a destination that carries `service.lock`
  evidence, that is a non-empty directory, or that sits **inside** a data root carrying lock evidence
  (so a live `/data` is never written into); it authenticates the archive, checks every manifest
  digest, and stages the result beside the destination before moving it into place, so a failure
  leaves no half-restored root. The staging tree is paused from its first byte, so even a tree a crash
  left behind cannot be started. It never modifies the source root.
- **A restored root is paused.** `RESTORE-PAUSED.json` is written into it, and startup refuses to
  serve such a root — with no lock taken and nothing listening — until an operator reviews the data
  and runs `node scripts/data-tools.mjs promote <root>`. The doctor reports the pause as
  `restore-not-promoted` and never promotes anything itself. Promotion refuses a root that is not
  paused, that holds lock evidence, whose catalog or control store is unreadable, or whose archive no
  longer matches the digest the marker recorded while that archive is still present.
- **The archive's author is inside the trust boundary.** The payload is authenticated, but a
  passphrase holder can encrypt an archive of their own making. The path allowlist, the
  strict-inside-the-destination check and the paused root exist so that even such an archive cannot
  write outside the destination or serve itself — they are not a claim about an archive's contents.
  Review a restored root before promoting it.
- Symlinks fail closed everywhere.
- Test a restore into an isolated root and inspect it before trusting a backup. Copy completed
  archives somewhere else as well: same-disk archives are not a backup.

The format, the cryptography and its parameters, the key-handling rules, the exact verification
guarantees and the honest limits are in [Backup, restore and promotion](BACKUP.md) — including the
two facts that decide whether you can recover at all: the archive is only as good as its passphrase,
and it is an offline backup taken with the service stopped.

## Upgrades and rollback

Stop only the application, let it drain, and check that `service.lock` is gone before
switching releases. Point `current` at the new release, start, and verify readiness (`/readyz`)
and the deny cases above. Roll back build artefacts only — never replace newer boards or documents
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
- **An unclean kill leaves `service.lock`.** Startup fails closed with no automatic recovery
  until an operator clears it deliberately; see
  [Startup configuration and the service lock](#startup-configuration-and-the-service-lock).
  With `restart: unless-stopped` this looks like a crash-loop, so check the log for the lock
  message before assuming a code fault.
- **Request logging is method, path and status only** — no query strings, headers or bodies.
- **An approval is not a deployment.** Creating, listing, consuming or revoking one touches no
  release, repository, host or credential, starts no run, and performs no commit, push, deploy,
  spend, provision or publish; the action it authorises still needs a separate exact grant.
- **Alert keys live in the data directory** (`alerts/vapid.json`, 0600). Rotating them
  invalidates every subscription.
