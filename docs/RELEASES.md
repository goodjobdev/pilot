# Releases: candidates, previews, promotion and rollback

A release is not a directory you happen to point somewhere. It is four durable records in one data
root's control store — an **immutable candidate**, a **disposable preview** created from one, and the
**promotion** and **compatible rollback** that point the service at a candidate — plus one report the
running build publishes about itself. The records live in the same reviewed control schema as
approvals and sessions: one operation per record, validated on the way out exactly as on the way in.
Nothing in this tool builds an image, deletes a release, restarts a service, commits, pushes, deploys
or publishes anything.

The operator path is `scripts/releases.mjs`. It reads the application sources, so run it with the
repository toolchain: **`pnpm exec tsx scripts/releases.mjs <command> ...`**. Run without
`--execute`, every changing command prints exactly what it would do and writes nothing.

## The candidate

A candidate is a record plus an artifact reference. Every field is required and strictly validated:

| Field | Meaning and rule |
|---|---|
| `candidateId` | The candidate's own identity: 1-120 characters of `A-Za-z0-9._:-`. Never reused for different content. |
| `releaseId` | The durable release identity — the same token the service lock and the release manifest record. |
| `schemaId` | The storage schema the candidate expects. It must be one this build supports (`pilot-state-1`). |
| `sourceDigest` | 7-64 lowercase hex characters: the exact source revision the artifact was built from. |
| `artifact` | The image identity: `repository`, `kind` (`digest` or `immutable-tag`), `identity` and `reference`. |
| `createdAt` | The creation instant: an ISO-8601 UTC instant with milliseconds. |
| `environment` | The environment it targets, for example `hosted-vps`. |

An artifact identity is a **sha256 digest** (`sha256:` plus 64 hex characters, referenced as
`<repository>@sha256:...`) or a **version- or release-shaped immutable tag**. A malformed digest, an
empty repository, a repository with a scheme, a reference that does not address exactly its declared
identity, a tag that is not version-shaped (`tip-of-main`) and the conventional moving tags
(`latest`, `main`, `edge`, `stable`, …) are all refused by name. An unknown field, a missing
field, a path-like id, a malformed instant and an unsupported `schemaId` are refused too. There is no
permissive mode and no default for any of them.

**A candidate is immutable.** It is one control-store operation keyed by its candidate id, admitted
once and never updated, and reading it back recomputes a content fingerprint over the record and
refuses a record whose fingerprint does not match its own content. Recording the *identical* record
again reads back the record that is already stored and writes nothing new; recording the **same
candidate id with different content is refused** — a changed build needs a new candidate id. Because
the record is in the control store, a restart cannot lose it.

```sh
pnpm exec tsx scripts/releases.mjs candidate create \
  --data /data --id cand-2026-02-01 --release release-2026-02-01 \
  --schema pilot-state-1 --source <40 hex characters> \
  --repository ghcr.io/owner/pilot --identity sha256:<64 hex characters> --kind digest \
  --environment hosted-vps --execute
```

## The preview

A preview is created **from a candidate** and is **explicitly disposable**: the record carries
`disposable: true` and `promotable: false`, and promotion names a candidate. Naming a preview id
for promotion is refused with a message that names the candidate to promote instead — a preview is
never promoted directly, and nothing in this build can promote one.

A preview is **isolated by construction**. The container port reports the facts it established and the
store validates every one of them; when any property cannot be established, the preview is **refused**
rather than degraded:

- **Its own data root.** The preview's data root must be strictly inside the designated preview root
  (`--preview-root`), which is never the live data root. A data root that is the live data root,
  inside it, or an ancestor of it is refused: a preview root placed inside the live data root can
  therefore never yield a preview at all.
- **No live data readable or writable.** The preview's data root must not overlap the live data root in
  either direction, and **every mounted host path** must be strictly inside the preview's own data root
  and must not overlap the live data root. The live store, the projects and the credentials directory
  are not mounted, so a preview cannot read or write them.
- **No production credentials or secrets.** The port's credential list must be empty. A placement that
  would mount even one production credential path is refused.
- **No tunnel.** A placement that reports a tunnel is refused. A preview is never routed anywhere.
- **Loopback-only publishing.** Every published port must be on `127.0.0.1`, `::1` or `localhost`
  and in the unprivileged range; anything else (`0.0.0.0`, a host address, port 80) is refused.
- **A bounded lifetime.** 1 minute to 24 hours, and never longer than what was requested. The record
  carries `createdAt` and `expiresAt`, and a preview past its expiry is reported as `expired`.
- **Hard resource caps.** Memory, CPU and PIDs must all be present, inside the documented bounds
  (memory 64MiB-8GiB, CPU 0.1-4, PIDs 16-512) and no wider than what was requested. A placement that
  omits a cap is refused: absent means "not bounded", and an unbounded preview is not a preview.

At most **4 previews** may exist at once; creating another is refused and nothing is created.

**The durable order is what makes a preview safe to create.** The *reservation* is written first, so a
container can never exist without a durable record; the *placement* the port established is validated
and then written second; the *discard receipt* moves the reservation's own record to `succeeded` with
the paths it removed. A preview whose container could not be created, or whose placement was refused,
is left as `creating` — visible, discardable, and never reported as an active preview.

**Discarding removes only what the preview created.** The port removes the container and the preview's
own data root and reports what it removed; the store refuses a report that names anything outside that
data root (the live data root above all) and records nothing. A discard is revision-checked, and
discarding an already discarded preview reads back unchanged and calls no port.

```sh
pnpm exec tsx scripts/releases.mjs preview create --data /data --preview-root /srv/pilot-previews \
  --id preview-2026-02-01 --candidate cand-2026-02-01 \
  --lifetime-ms 3600000 --memory-bytes 268435456 --cpus 0.5 --pids 32 --execute
pnpm exec tsx scripts/releases.mjs preview discard --data /data --id preview-2026-02-01 --execute
```

**What a preview is, honestly.** It is a smoke test of one artifact against its own empty data root:
does the image start, can it open the schema it declares, does it come up at all. It is not a copy of
production. The bundled port runs the candidate image with `--network none`, a read-only root
filesystem, no capabilities, no inherited environment, no production credentials, one mount (the
preview's own data root) and publishes nothing at all — publishing a port would mean giving the preview
an origin and an identity configuration, and this build will not hand a preview production identity
configuration. Two further limits are stated rather than hidden: the store validates the facts a port
**reports** (it cannot inspect a container's real mounts itself), and the expiry is a recorded bound
that this build never enforces by killing a container — the container is removed by a discard, and an
expired preview is reported as expired.

## Promotion and rollback

A **promotion** points the service at one candidate. It records, at the next revision of an
append-only chain: the candidate promoted, the release that was previously active (the **rollback
target**), the instant, the actor, and the immutable release pointer the port activated.

- **It is revision-checked.** The caller passes the revision it read, and a promotion whose revision is
  not the current one is refused before anything is activated. Underneath that, the key of the new
  revision is a compare-and-swap inside the control store's own transaction, so two actors that read
  the same revision cannot both write it: the loser is refused, and the refusal says plainly that the
  port may already have pointed the service at its candidate, so an operator must re-read the state and
  decide.
- **It verifies the target can start before the pointer moves.** Both a promotion and a rollback run
  a pre-flight while the `current` pointer is still untouched, and refuse on **any** of: a service lock
  in any state other than absent (`service-lock-present`, `service-lock-active`, `service-lock-proven-dead`
  or an unreadable lock) — a promotion must never leave a locked root with a moved pointer; a restored
  root still carrying `RESTORE-PAUSED.json`; a staged `<release-root>/<releaseId>/release.json`
  (read with the same manifest loader startup uses) whose `releaseId`, `schemaId` or `sourceDigest`
  does not match the candidate; and a storage schema the target release cannot read — the **same**
  compatibility rule a rollback obeys, run on a promotion too. The dry run prints this pre-flight as
  `preflight`, so the plan shows the startability the switch depends on, and the refusals happen before
  the pointer is swapped. The observation is also injected into the durable store's promotion
  (`canActivate`), so every caller — not only this CLI — is refused before the pointer moves.
- **It never deletes.** A promotion and a rollback leave every release directory and every image
  exactly where they were: the promotion port swaps the `current` symlink atomically and reports the
  paths it removed, and a report naming any removal is refused and nothing is recorded.
- **A lost race cannot leave the pointer and the record disagreeing silently.** If two actors read the
  same revision, the loser's compare-and-swap is refused; because its activation may already have moved
  the pointer, the loser re-points the service at the recorded winner before it reports the conflict. The
  tool never restarts the service, so this happens before any start on a release nobody recorded.
- **It does not restart anything.** After a promotion the operator restarts the service deliberately.

A **rollback** returns to the recorded previous release. It must be **compatible or it is refused**:
the target release can be started only if it can read the storage schema actually on disk.

| On-disk schema, compared with the target release's schema | Result |
|---|---|
| Equal | Compatible: the rollback proceeds. |
| **Newer** than the target understands | **Refused.** Rolling back would start a service that misreads the data. |
| Older than the target expects | Refused: the target release would refuse to start on it. |
| A schema this build cannot map to a version | Refused: compatibility cannot be proved. |
| Absent, busy or malformed | Refused rather than assumed. |

When a rollback is refused, **do not force it**. Stay on the promoted release, or restore the matching
state from the encrypted full-state backup into a new root and promote that:

```sh
node scripts/data-tools.mjs verify /srv/pilot-backups/pilot-<date>.pbkp
node scripts/restore.mjs /srv/pilot-backups/pilot-<date>.pbkp /srv/pilot-restore
node scripts/data-tools.mjs promote /srv/pilot-restore
```

The refusal message says exactly this; see [Backup, restore and promotion](BACKUP.md). A rollback is
itself reversible: it records the release it left, so a second rollback returns there.

## What the running service reports

- `/readyz` is unchanged: the same expected-version facts and the same reasons. If a promotion exists
  and the identity this process runs as is **not** that candidate, the reason
  `release-identity-mismatch` is added.
- `GET /api/release` (owner-authenticated, read-only, path-free) reports the release identity this
  process runs as, the storage schema it expects, and which candidate the store says is promoted:
  `{"release": {...}, "promotion": {"state": "match" | "mismatch" | "not-promoted", "revision": n,
  "candidate": {...}}, "reasons": []}`, with `reasons` naming `release-identity-mismatch` or
  `release-promotion-unreadable`.
- **Startup refuses to serve a build that is not the promoted release.** If a promotion is recorded and
  the manifest's release id, schema id or source digest does not match it, the process refuses before
  anything listens, releases the lock it took and exits non-zero. A promotion history that cannot be
  read refuses the start the same way. With no promotion recorded the previous behaviour is unchanged,
  which is what makes a fresh or local instance possible.

## Operator runbook

1. **Stage the release.** Build into an immutable release directory under the release root
   (`<release-root>/<releaseId>`), beside the `current` symlink the service starts through. Never
   reuse a release id for different content.
2. **Record the candidate** with `candidate create … --execute`; keep the candidate id it prints.
3. **Preview it** with `preview create … --execute` when you want a smoke test. Read `status` and
   `previews`, then discard it with `preview discard --execute`. Nothing about a preview touches the
   live data root.
4. **Promote it** with `promote --data <root> --candidate <id> --expect-revision <n> --actor <you>
   --release-root <release-root> --execute`. The revision is what `status` reports (0 on a data root
   where nothing has been promoted). The command **pre-flights** the target: it refuses a held lock, a
   paused root, a mis-staged release directory and an incompatible schema **before** swapping the pointer,
   so a refusal leaves `current` exactly where it was and records nothing.
5. **Restart the service** deliberately, then verify: `/readyz` reports 200, `GET /api/release`
   reports `{"promotion": {"state": "match"}}`, and the deny cases in
   [Deploying Pilot](DEPLOYMENT.md#verify-before-you-trust-it) still hold.
6. **Roll back** with `rollback --data <root> --expect-revision <n> --actor <you> --release-root
   <release-root> --execute`, then restart. The same pre-flight runs, so a held lock refuses the rollback
   before the pointer moves — exactly the failure a crash that left `service.lock` behind used to cause.
   If it is refused, read the reason: it names the schema versions and points at the encrypted backup
   restore path. Do not edit `control.sqlite`, do not delete a release directory, and do not clear
   `service.lock` to force a start.
7. **Report the state** at any time with `status` (read-only). It prints the promoted revision, the
   rollback target, what a rollback would do now, the previews that exist, and the **start blockers** the
   doctor would report for this root (`service-lock-*`, `restore-not-promoted`, `port-in-use`), so the
   command an operator uses to decide actually says whether the root is startable.

Every command opens the control store of the data root it is given and takes no service lock: read
commands are safe beside a running service, and a promoting command should be run while the service is
stopped, so the pointer swap and the restart are one deliberate sequence. The read-only commands
(`status`, `candidates`, `previews`) create nothing at all: on a root with no control store they report
`controlStore: absent` rather than initializing one.

**Checking `service.lock` yourself is now a fallback, not the mechanism.** The tool verifies
startability itself and refuses a held lock, a paused root, a mis-staged directory and an incompatible
schema before it moves the pointer. Checking that `service.lock` is gone before you promote, and
clearing a stale lock deliberately when it is not, remains the runbook step for the start itself — but
you no longer rely on remembering it to keep the tool from reporting a success the service then refuses.

## What this deliberately does not do

It does not build, pull, tag or delete an image or a release directory; it does not start, stop,
restart or reconfigure the service; it does not create a second data root; it does not mount a
production credential into a preview; it does not serve an artifact from the application; and it does
not promote anything automatically at startup. There is no agent-facing action, route or tool that
promotes or rolls back: promotion is an operator step with an explicit revision.
