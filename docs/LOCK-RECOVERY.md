# Service lock ownership and recovery boundary

This module is wired into startup and into backup, and it is still not a supervisor. Startup
acquires the `service` lock after the data root exists and before any store is opened or anything
listens, keeps it until the application has closed (the durable control store is closed before the
lock is released so the lock outlives every writer), and releases it in the shutdown path; a start
that cannot acquire it, or that fails to open the control store, releases what it created and exits
non-zero. Backup refuses to proceed while a live lock is present. The module still does not
start/stop a service, inspect a host supervisor, recover a lock, or prove that a supervisor is
stopped. Any existing lock blocks acquisition, including one whose recorded process is proven dead.
Offline quarantine/removal is a later explicit operator workflow and must preserve evidence.

## Proposed API

`acquireServiceLock(options)` exclusively creates `<canonical-root>/service.lock`
with mode 0600. Options include `purpose` (`service | backup | restore`),
`rootId`, `releaseId`, and `schemaId`; the caller must obtain these from the
already-validated workspace identity, immutable running release manifest, and
supported storage schema respectively. The caller may inject `now`, `nonce`,
`currentProcess`, and process observer helpers for deterministic tests. The
version-1 record contains canonical root path, logical root ID, purpose, release
and schema IDs, random instance nonce, creation time, and PID plus optional
process-start and boot identity.

A successful result provides a deeply readonly and deeply frozen `metadata`
view (fields and the nested process identity cannot be assigned, at compile time or
at runtime) plus `release()`. Complete metadata is validated and serialized under
the 16,384-byte UTF-8 limit before exclusive creation, and the serialized record
itself is parsed and re-validated there too. Only the declared process-identity
fields are copied from an injected `currentProcess`, so an arbitrary property (or a
`toJSON`) cannot alter what is stored: a successful acquisition is always readable by
inspection. Release uses a separately captured nonce, taken from the validated stored
record, and checks filesystem device/inode and nonce/root ownership before unlinking.
Initialization failure preserves any created lock evidence and closes its file
handle. It refuses to unlink a replaced or mismatched lock.
Callers must release only after their writers are closed; this helper does not
implement drain/shutdown ordering.

`inspectServiceLock(root, expected?, dependencies?)` is read-only. Its
classification is `absent | active | proven-dead | ambiguous`. Expected release
or schema mismatch is a diagnostic and remains ambiguous. PID existence, file
age and version mismatch never authorize takeover. Without a reliable injected
observer, process status is unknown, including when the recorded PID equals the
current PID; PID equality alone does not identify a process instance. A known reused PID or boot/start identity
mismatch can establish the recorded process is no longer the owner, but still
does not remove the lock or establish that an external supervisor is stopped.

Legacy, malformed, unreadable, foreign-root, symlink and nonregular locks remain
ambiguous evidence. A symlinked root directory is rejected by both inspection and
acquisition; the root's canonical real path is recorded. No automatic stale-lock cleanup exists.

## Concurrency and security limits

Exclusive file creation prevents cooperating callers from simultaneously
acquiring the same absent lock. The process identity and filesystem checks are
diagnostic/cooperative fencing, not hostile same-UID race-proof OS isolation.
There is a pathname race between release validation and unlink; deployment must
not treat this as a security boundary against another process with the same
filesystem permissions. The helper never follows a lock symlink, and private
file permissions are requested, subject to platform umask/filesystem behavior.
`service.lock` evidence must be preserved for explicit review rather than
deleted based on age or an assumption about PID/supervisor state.

No automatic recovery command, general shell facility, or external service manager is
provided by this slice.
