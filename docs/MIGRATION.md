# Migrating the legacy conversation

## What "legacy" means here

Pilot has always had **one conversation per project, created lazily**: the first time a project's
agent is opened, the harness creates Pi Durable's reserved *root* conversation, and that is the only
conversation the project ever has. Pi exports that reservation as **`ROOT_CONVERSATION_ID` = `1`**,
so the conversation's id is `1` and its store is:

```text
<data root>/agents/<projectId>/session.sqlite
```

The project's conversation has no name, no owner-visible identity and no links: the interface reaches
it through the project's agent view. A **legacy conversation** is exactly that record — the unnamed
root conversation a project already has.

The migration adopts it as a named session in the registry described in [Sessions](SESSIONS.md):
the session **id is the conversation id** (`1`), the name is derived deterministically from the
project's own name, and where the approved roots contain the project's folder, the folder is linked
as a workspace. A project whose folder the approved roots do not contain still gets its session; the
report says that it carries no workspace link, and says why.

## It is idempotent, and it can be dry-run

The migration considers every registered project in id order and, for each one:

1. reads whether a conversation store exists on disk — this is an `lstat`, never an open;
2. if there is none, reports `no-conversation` and does nothing;
3. if the session is **already registered**, reports `already-adopted` and **writes nothing at all**;
4. otherwise computes the name, and writes one session (with at most one workspace link).

Running it twice therefore produces **the same registry state**: the second run writes no session,
no revision and no link, and its report says `already-adopted`. Adopting a conversation that is not
there is a no-op too, so a project with no conversation at all is safe.

`dryRun: true` performs the same reads and the same link resolutions and **writes nothing**: it
reports exactly what it would create, and the registry is byte-for-byte what it was.

A project whose computed name is already held by another live session is **refused** and reported,
never renamed and never skipped silently. The migration never invents a name.

## It changes no model setting and calls no provider

The migration opens no harness, reads and writes no transcript, and sends nothing to a model
provider. It cannot: it reads a conversation store's existence with an `lstat`, and it writes one
record into the durable control store. Opening a harness to *find* the conversation is deliberately
avoided — `Harness.open` followed by `root()` commits the very root conversation the migration
exists to find, and resuming one would run recovered work.

The adopted session declares **no** model choice (`model: null`), so no provider, model or thinking
selection is recorded, changed or applied. The live conversation keeps whatever model it already
had.

## Where it runs

**At start.** Every start runs the migration before it listens, on the projects the catalog holds at
that moment. When there was something to report (at least one conversation, or a refusal) the start
writes one deterministic line:

```text
Session migration: {"dryRun":false,"counts":{"projects":1,"conversations":1,"adopted":1,"alreadyAdopted":0,"withoutConversation":0,"refused":0},"actions":[...]}
```

The line carries project ids, session ids, the action and a reason — never a filesystem path. A start
with no registered project, or with registered projects but no conversation yet, logs nothing. A
migration that fails is reported on stderr and never stops the process from serving; nothing is
adopted in that case.

**On demand.** `POST /api/sessions/migrate` (owner-only, canonical origin required) runs the same
migration and returns the report as JSON:

```sh
# what it would do, writing nothing
curl -sS -X POST "$PILOT/api/sessions/migrate" \
  -H "content-type: application/json" -H "origin: $PILOT_ORIGIN" -H "x-dashboard-token: $TOKEN" \
  -d '{"dryRun": true}'

# do it
curl -sS -X POST "$PILOT/api/sessions/migrate" \
  -H "content-type: application/json" -H "origin: $PILOT_ORIGIN" -H "x-dashboard-token: $TOKEN" \
  -d '{}'
```

## Operator steps

1. **Stop nothing by surprise.** The migration is safe to run at any time, but the start-time run
   happens before anything is served, so the simplest sequence is an ordinary restart: start Pilot
   as usual and read the `Session migration:` line.
2. **Dry-run first** if you want to see the plan without writing: `POST /api/sessions/migrate` with
   `{"dryRun": true}`. It writes nothing at all.
3. **Apply** with `{}` (or accept what the start already did).
4. **Verify** with `GET /api/sessions?projectId=<projectId>`: each adopted project should show one
   session whose id is `1`, whose name is `<project name> legacy conversation`, whose `model` is
   `null`, and whose links contain the project folder when the approved roots contain it.
5. **Run it again** if you are unsure: the report should show `alreadyAdopted` and the listing must
   be identical. Running it twice is the expected state, not an error.
6. **If a project is reported as refused** because its computed name is taken, decide the name
   yourself: rename the session that holds it (or the one you want), then run the migration again.

### What it does not do

It does not create a conversation for a project that has none, does not rewrite or re-index a
transcript, does not copy a conversation into another one, does not fork anything, does not touch
worktrees, grants or approvals, and does not change any provider, model or thinking selection. The
agent transcripts remain what they were: the registry is a new projection beside them, not a
translation of them.
