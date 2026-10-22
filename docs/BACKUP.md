# Backup, restore and promotion

An offline backup is one **encrypted single-file archive** of the complete application state under a
data root, taken while the service that owns that root is stopped. A restore writes an **isolated
root that is paused**: it is not served until an operator reviews it and promotes it deliberately.
The tools are `scripts/data-tools.mjs` (backup, verify, restore, promote) and
`scripts/backup-crypto.mjs` (the archive format and its cryptography).

Everything below is the behaviour of the code, not an aspiration. The honest limits are at the end
and they matter more than the feature list.

## What a backup captures

A backup walks the data root and captures:

| Source | Captured as | Why |
|---|---|---|
| `catalog.json` | `catalog.json` | The registry of projects, and where each project's data lives. |
| Each managed project's tree | `projects/<id>/...` | The board and the documentation the wiki owns, with the asset types the wiki may serve. |
| `media/` | `media/<sha256>.bin` | The immutable image media store: one object per accepted image, keyed by the hash of its stored bytes. Without it a restore would silently lose every stored image. |
| Each external project's dashboard | `projects/<id>/docs/dashboard/...` | The board and the inert source snapshots; the repository itself is its own backup. |
| `control.sqlite` | `control.sqlite` | Durable operations and receipts, the outbox, approvals, named sessions and their lifecycle. |
| `agents/<projectId>/*.sqlite` | `agents/<projectId>/...` | The per-project agent session databases. |
| `settings/*.json` | `settings/...` | Installation identity and model preferences. |

`media/` is captured in full and is **not** an exclusion: one file per accepted image, named with the
sha256 of its bytes, which is exactly the shape the application writes. An entry under `media/` that is
not a regular file of that shape (a directory, a symlink, a name that is not 64 lowercase hex
characters plus `.bin`) is reported as excluded rather than copied blindly.

The **container itself** is validated before its contents are read, so the manifest can never claim a
capture that did not happen. A `media` that is a **symbolic link** is never followed — following it
would archive objects from outside the data root — and a `media` that is **not a directory** cannot
hold objects at all; both **fail the whole backup closed**, with a message naming what it found, rather
than being read as an empty store. A `media` directory that exists but **cannot be read** fails the
same way, instead of contributing zero objects without a word. A data root that has never stored an
image simply has no `media` directory: that is not a failure, the backup succeeds, and no `media/`
entry is claimed for it.

Documentation and media means Markdown (`.md`, `.mdx`) plus exactly the asset types the wiki may
serve: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.svg`, `.html`, `.htm`. Nothing else
inside a project tree is copied: a repository's source, tests and lockfiles are the repository's own
backup, and generated or vendored folders (node_modules, dist, build, out, target, coverage, vendor,
venv, .git, .astro, .svelte-kit, .next, .nuxt, .turbo, .cache, test-results, playwright-report,
.runway, .kilo, .pi-web and tmp) are never planning data.

A symlink anywhere inside planning data fails the whole backup closed. Nothing is followed.

### What is deliberately excluded

The manifest inside every archive states the exclusions and their reasons, and the tool also reports
any data-root entry it did not recognise rather than copying it blindly. `media/` is a **captured**
entry, not an unrecognised one, so it is never listed here:

| Excluded | Reason |
|---|---|
| `credentials/` | Provider API keys, provider sign-in tokens and project deploy keys are secrets. **This milestone adds no opt-in to include them**: an archive carries no credential, by construction, and a restored root therefore has none. |
| `alerts/` | The private VAPID signing key and the device push endpoints that belong to it. The endpoints are only meaningful with that key, so a restored root re-establishes alerts by enabling them again on each device. |
| `repositories/` | Agent git worktrees, derived from the project repository, which is its own backup. |
| `forks/` | Child fork worktrees (`forks/<projectId>/<childSessionId>`). Each one is derived state: a commit of the project repository checked out again, held as a git worktree registered inside that repository — which is itself excluded, because the repository is its own backup — so a restored root could not reuse the directory anyway and no commit is lost with it. The fork records that describe them **are** captured: they are rows of `control.sqlite`. |
| `service.lock` | Ownership evidence for the process holding the root. A backup is refused while **any** lock evidence is present — a live lock, a lock recorded for a process that is gone, a malformed one — and a lock is never part of a backup. It then takes its own lock (purpose `backup`) for the duration, so during a backup *this tool* is the holder; restore and promotion only refuse evidence, they never take a lock. |
| `RESTORE-PAUSED.json` | The restore pause marker of a restored root, not application data. |
| `snapshots/` | The bounded board revision history **the application itself writes**: `snapshots/<projectId>/<timestamp>-<uuid>.md`, the newest 20 per project, the older ones pruned automatically. It is derived from the boards, which *are* captured, and it is not the board a project is served from, so a restored root rebuilds it as boards are edited. |

An unrecognised entry at the data root (or under `settings/` or `agents/`) is listed as excluded
with the reason `not captured by this tool`, so the manifest never overstates what a preview of the
archive contains. `snapshots/` is **not** such an entry: the application writes it, so it is named
in the exclusion list with a reason of its own instead of being reported as something this tool
failed to recognise. `forks/` is named exactly the same way and for the same reason — the application
writes it — so the fork worktrees are a stated exclusion rather than an entry that fell into the
unrecognised-entry branch. The test that drives this is
`tests/server/fork-store.test.ts` ("the child fork worktrees are a stated exclusion of a backup,
never an entry it failed to recognise"): it backs up a data root that really holds a child worktree and
asserts the exclusion is named with its own reason, that no file under `forks/` is captured, and that
the archive's own manifest says the same thing.

## One consistent copy per database

SQLite is copied **through SQLite itself** — `VACUUM INTO` on a read-only connection — and never by
copying the database file's bytes. The manifest records the method as `sqlite-vacuum-into`.

This is not a detail. The durable control store runs in **WAL mode**, so a committed row can live
entirely in the `-wal` sidecar until a checkpoint. A byte copy of `control.sqlite` alone can contain
none of it, or a torn mix of pages from two different moments. `VACUUM INTO` reads one consistent
committed snapshot through the same SQLite that wrote it and writes a fresh, single-file database.
The sidecars (`-wal`, `-shm`) are never copied on their own, because the copy already contains
everything committed.

Each copy is produced in a private scratch directory (0700, mode 0600 per copy, removed afterwards),
the archive then reads that immutable copy twice: once to hash it and once to stream it into the
payload. Both the size and **the sha256 the manifest records** are re-checked as those bytes stream,
so a source that changes under the tool fails the backup with `The source changed while it was being
archived` rather than producing an archive that disagrees with its own manifest — a disagreement that
would otherwise surface only when the archive was restored.

What the copy contains is exactly what was **committed** at that moment. Uncommitted transactions,
connections in the middle of a write, and anything outside the data root are not in a backup.

## The archive format

One file, streamed, never buffered whole:

```text
"PILOTBKP"   8 magic bytes
uint32be     header length
header       versioned JSON: format, version, cipher, created, kdf{name,N,r,p,keyLength}, salt, nonce, app
ciphertext   AES-256-GCM of the payload, in 64 KiB blocks as they are read
tag          16-byte GCM authentication tag over the header and the whole payload
```

The payload inside the ciphertext is a sequence of newline-delimited JSON records: a **manifest**
record first, then one `file` record and exactly that many bytes per file, then an `end` record.
The manifest carries the format version, the creation time, the application release and schema
identity when it is available, the logical root id (never an absolute path), the database copy
method, every file with its **size and sha256**, and the explicit exclusion list above.

## The encryption scheme and its parameters

| Element | Value |
|---|---|
| KDF | **scrypt**, N = 32768 (2^15), r = 8, p = 1, 32-byte key, 16 random salt bytes per archive. About 32 MiB and tens of milliseconds per derivation. |
| Cipher | **AES-256-GCM**, 12 random nonce bytes per archive, 16-byte tag. |
| Authenticated header | The header bytes are the GCM **additional authenticated data**, so the format version, the KDF parameters, the salt and the nonce are covered by the same tag as the payload. A rewritten header fails authentication instead of being obeyed. |
| Bounded header | A reader refuses a header larger than 65536 bytes and refuses KDF parameters outside N ≤ 2^20, r ≤ 64, p ≤ 16, key length ≤ 64. The derived memory request is capped at 512 MiB, so a hostile header cannot ask for unbounded work. |
| Bounded memory | Files are hashed and streamed in blocks; the manifest is the only whole object held in memory. |

### Key handling

- The passphrase comes from **the environment** (`PILOT_BACKUP_PASSPHRASE`) or, when the operator
  opts in with `PILOT_BACKUP_PASSPHRASE_STDIN=1`, **one line from stdin**. It is **never** read from
  the command line: a command line is visible in the process table and the shell history.
- A missing, empty, blank or shorter-than-12-character passphrase **fails closed** with a clear
  message, for writing and for reading alike.
- The passphrase is never written into the archive, never put in a log line, and the derived key
  buffer is zeroed when the operation ends. String copies of a passphrase inside the process cannot
  be zeroed by JavaScript, so this is best-effort hygiene, not a guarantee.

## Verification guarantees

**A backup**: refuses a root whose lock inspection is anything other than `absent`, takes the data
root lock through the reviewed `src/server/service-lock.ts` module (purpose `backup`) once that
evidence is gone, reads and hashes every source, and streams the payload. A refusal leaves the
holder's lock byte-identical: the tool never unlinks, renames or truncates it. An archive is created
**exclusively**, so an existing file at the archive path is never overwritten, and if a write fails
the writer removes the partial archive **it created itself** and never unlinks a path it did not
create.

**An archive can be verified without restoring it**: `node scripts/data-tools.mjs verify ARCHIVE`
runs the same authentication and the same every-digest check a restore runs, and writes **nothing at
all** — no staging directory, no destination, no lock, no change to the archive. It is the read-only
answer to "is this archive still intact, and will it restore?".

**A restore verifies before it writes into the destination**:

1. the destination is refused if it carries `service.lock` evidence (a live data root), if it is
   not an empty directory (an existing empty directory is used, not merged into), and if **any of its
   ancestors** carries lock evidence — a restore never writes inside a root a service is using, so
   `restore ARCHIVE /data/restored` against a live `/data` is refused whatever the destination is
   called (that refusal names no path, so it cannot be used as an oracle);
2. the archive's magic, header version, cipher and KDF parameters are validated;
3. the payload is decrypted **into a private staging directory beside the destination**, where the
   GCM tag authenticates the whole archive and every file's bytes are checked against the digest its
   manifest records, in the manifest's own order, with the path allowlist refusing anything the tool
   never writes — no `.` or `..` segment, no empty segment, no leading slash, no backslash, and only
   the documented shapes;
   the staging tree is **paused from its first byte**: the marker is written into it before a single
   archive byte is read, so a tree that only a crash could leave behind is already paused, and a tree
   with a catalog but no control store is never served as if it were complete;
4. the payload's end record must agree with the manifest, the catalog must parse, and every catalog
   project must carry a board;
5. only then are the marker's final counts written, and the staging directory renamed into place, so
   a failure leaves **no destination and no half-restored root**; the staging directory is removed on
   every failure path.

The write site is the second containment layer behind the allowlist: every mapped path is resolved
against the staging root and must be **strictly inside** it, checked immediately before the directory
and the file are created, so even a manifest that somehow passed the allowlist cannot name a target
outside it.

The honest ordering: file bytes are decrypted into that private staging area *before* the tag
verifies, because a streamed archive can only be authenticated when its last byte is read. Nothing is
moved into the destination, and the destination is never created, until every check has passed.

A restore never modifies the source archive or the root it came from, and it rewrites each catalog
project path to `<restored root>/workspaces/<id>`, so a restored root can never point at the project
trees of a live root.

## The restore and promotion procedure

```sh
# 1. Stop the service that owns the data root, and confirm no lock is held.
docker compose --env-file .env stop dashboard

# 2. Back up (the passphrase comes from the environment, never from the command line).
PILOT_BACKUP_PASSPHRASE='…' node scripts/backup.mjs /data /srv/pilot-backups/pilot-$(date +%F).pbkp

# 3. Check the archive before you trust it: this authenticates it and checks every payload digest
#    without writing anything anywhere.
PILOT_BACKUP_PASSPHRASE='…' node scripts/data-tools.mjs verify /srv/pilot-backups/pilot-2026-01-01.pbkp

# 4. Restore into a NEW, isolated, empty (or absent) directory: never over the live root, and never
#    inside one.
PILOT_BACKUP_PASSPHRASE='…' node scripts/restore.mjs /srv/pilot-backups/pilot-2026-01-01.pbkp /srv/pilot-restore

# 5. Review the restored root deliberately, then promote it to remove the pause marker.
node scripts/data-tools.mjs promote /srv/pilot-restore

# 6. Start the service against the restored root only when you mean to serve it.
```

The same four commands are available as one `node scripts/data-tools.mjs backup|verify|restore|promote`
command line, which prints its own usage (the older wrapper scripts' usage lines still call the
backup argument a *directory*; it is now the archive file path).

### A restored root is paused

A restore writes `RESTORE-PAUSED.json` into the restored root. It records the archive's name, the
path it was restored from and its sha256, the archive format version, the backup's creation time and
file count, the logical root id, the application identity, whether the restore finished
(`complete`), and the fact that no credentials were restored.

It is written **before a single archive byte is read**: the staging root carries it with
`complete: false` and no counts while the archive is still being verified, and it is rewritten in
place with the final facts only once every check has passed.
One consequence worth stating plainly: a tree that a crash left half-restored is already paused, so
it cannot be started and cannot quietly adopt an empty control store.

Until an operator removes it:

- **startup refuses to serve the root**, printing one message naming the marker and the exact
  promotion command, taking no lock, opening no store and listening on nothing;
- the **doctor reports `restorePause.paused: true`** and lists `restore-not-promoted` as a start
  blocker (it is a blocker, not corruption: `unsafe` stays false);
- nothing promotes the root automatically, and nothing ignores the marker: its **presence** is the
  signal, so even an unreadable or malformed marker still refuses the start.

`promote <root>` is the deliberate action that removes it. It refuses a root that carries no such
marker, a marker that is not a version-1 regular file, a root that holds any lock evidence (it may be
in use) and a root whose `catalog.json` is missing or whose control store is unreadable. When the
marker names the archive the root was restored from and that file is **still there**, its bytes are
re-hashed and must match the digest the marker recorded: a mismatch refuses the promotion, because
those bytes have changed since the restore. An archive that has since been moved away is not
re-checked, and promotion never writes to it. It deletes the marker file and nothing else.

### An older plaintext backup

Version-1 backups were a **plaintext directory** containing `manifest.json` and the Markdown files.
That format is still read, by an explicit branch (`stageLegacy`), because an operator holding an
older backup still needs to recover it; a version-2 archive is never reinterpreted as one, and the
marker records `archive.formatVersion: 1` when that branch was used. Version-1 backups are refused
rather than misread if their manifest is not a version-1 manifest. Backups are only ever **written**
in the encrypted single-file format.

## Honest limits

- **This is an offline backup.** It requires the service that owns the root to be stopped. It is not
  replication, not a snapshot of a running service, and not a continuous archive.
- **It is only as good as the passphrase.** Lose it and the archive is unrecoverable; choose a weak
  one and the archive's protection is that weakness. There is no recovery key and no escrow.
- **A restored root has no credentials.** Provider API keys and sign-ins are absent, so sign in again
  under **Providers & models**; project deploy keys are absent, so generate new ones and add the
  public keys at the provider. Alerts must be enabled again on each device.
- **A restore is not a merge.** It writes a fresh root and refuses a non-empty destination. There is
  no partial restore, no per-project restore and no reverse-import into a live root.
- **A backup holds committed data only.** Anything a crash left uncommitted is not in it, and a
  backup says nothing about work that was in flight.
- **A restored root keeps the fork records and none of their worktrees.** `control.sqlite` **is**
  captured, so a restored root lists the forks of the root it was backed up from — and every record
  still names the worktree path of *that* root. A discard acts on the path a record carries and
  re-checks that it is inside the root in force now, so this build refuses to touch those paths
  (`OUTSIDE_ROOT`) rather than following them out of the restored root. Such a fork is left as a
  deliberate operator decision, and this build has no path that clears one yet; see
  [Forks](FORKS.md#honest-limits).
- **The archive format is versioned but not eternal.** A future format version is refused by name
  rather than guessed at; keep the tool release that wrote an archive alongside it.
- **Copy completed archives somewhere else.** An archive on the same disk as the data root is not a
  backup: it does not survive that disk, that host or that filesystem.
- **The pause is not access control.** It stops an unattended restart from serving an unverified
  root; it does not encrypt the restored root, hide it or protect it from a same-UID process.
- **The lock is cooperative.** A same-UID process can ignore or remove `service.lock`; the lock
  stops a second Pilot, a start against a root another process owns and a concurrent backup, and it is
  not a security boundary. It is also not a fence around a directory: it is evidence *inside* a data
  root, which is why a restore refuses ancestors that carry it rather than trusting a path check.
- **Whoever holds the passphrase is inside the trust boundary.** The payload is authenticated by the
  same key it was encrypted with, which proves *that* archive is intact — it proves nothing about its
  contents. Someone who holds the passphrase can encrypt an archive of their own making, with any
  manifest and any files they choose. The containment rules — the payload path allowlist, the
  strict-inside-the-staging-root check and the paused root — exist exactly so that such an archive
  still cannot write outside the destination directory or make a restored root serve itself. They are
  not a defence of the restored root's *contents*: reviewing a restored root before promoting it is
  the operator's job, and it is the only thing standing between a crafted archive and a served one.

## Where it lives

| Concern | File |
|---|---|
| Backup, restore, promotion, manifest and payload | `scripts/data-tools.mjs` |
| Archive format, KDF, cipher, header and payload reader | `scripts/backup-crypto.mjs` |
| Service-lock protocol shared with startup | `src/server/service-lock.ts` |
| Refusing a paused root at startup and in the doctor | `src/server/main.ts` |
| Tests | `tests/server/backup-crypto.test.ts`, `tests/server/backup.test.ts`, `tests/server/entrypoint.test.ts` |

See [Deployment](DEPLOYMENT.md#backup-restore-and-promotion) for the operator section, and
[Service lock ownership and recovery](LOCK-RECOVERY.md) for what the lock does and does not prove.
