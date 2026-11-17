---
title: Cloudflare connection configuration
description: One owner-configured, revisioned credential and exact Worker binding, with no provider call and no deployment.
pilot:
  schema: 1
  id: cloudflare-connection-store
  kind: specification
  doc_status: draft
  feature_status: implemented
  verified_release: null
---

## Problem and outcome

An owner should enter one exact Cloudflare Workers account, script name and API token once, so a
future integration can reuse the binding instead of asking for credentials in every session. This
change installs **credential configuration only**: an owner-authenticated route stores one
revisioned record and reads back a sanitized view. It makes no provider request, checks no
Cloudflare permission, deploys nothing, exposes no token getter and installs no agent tool. Nothing
in the application consumes the stored credential yet, so configuring a connection does not by
itself enable any Cloudflare operation.

It is not MCP Code Mode or provider mutation support. It does not authorize a caller: the owner
actor is derived from the authenticated session, not from the request body. An owner actor value
accepted by the internal store is not authentication.

## Design contract

The one screen-level operation is an HTTP route, owner-only like every other route and behind the
unchanged Host, origin and session-CSRF enforcement:

- `GET /api/projects/<project uuid>/cloudflare-connections/<connection id>` reads one record.
- `POST` or `PUT` on the same path writes it.

It is **default-off**. An instance enables it with `DASHBOARD_CLOUDFLARE_CONNECTION=on`; while the
switch is not `on`, every method answers `503` with a named reason and the route opens no store,
creates no directory and writes no file. No interface control is installed, and no route lists
connections, returns a token or starts a deploy.

The project comes from the path and the owner from the session; the body supplies neither, so a
caller cannot configure a connection as another project or actor. An unknown project is `404`.

A successful `POST`/`PUT` body is `revision`, `target` (`accountId` and `workerName`), an optional
`enabled` that defaults to false, and one explicit `credential` action: `keep`, `replace` with the
token, or `remove`. `GET` and a successful write answer `200` with
`{connection: {projectId, connectionId, revision, enabled, credentialConfigured, targetDigest,
authority}}`, or `{connection: null}` when no record exists yet, which is revision 0. The view never
contains the token, the account id or the script name. `authority` is the fixed
`https://api.cloudflare.com`; no URL, host or account may be supplied anywhere.

Refusals say what happened and nothing more: a stale revision is `409` and changed nothing; an
invalid record, a token outside the accepted alphabet, or enabling without a credential is `422`;
another method is `405`; a disabled switch or unavailable storage is `503`. No refusal repeats the
token, and the request log records method, path and status only.

## Behaviour and data contract

The synchronous SQLite store requires existing data and project roots, and its caller must provide
**every** registered project root. The route reopens the store per request and passes the current
registered roots, so a project registered or moved later is rechecked before the next read or
write. The store rejects storage under those project roots, symlinks for its credential directory
and database file, and directory or file modes granting group/other access. Its unencrypted database
is at `<data>/credentials/cloudflare-connections.sqlite`; the directory and file are created with
0700 and 0600 permissions. This path-based check is not atomic against same-user filesystem
changes, mounts or hard links. **The application-user shell can read this file: it is not
encrypted at rest and it is not sandboxed.**

One record per project/connection binds a fixed Cloudflare Workers account ID and exact script name.
Only the fixed `https://api.cloudflare.com` authority is represented. Each successful change
increments the revision in an immediate SQLite transaction; a stale revision conflicts even across
independent database handles or after a restart. Credential actions are explicit: `keep` preserves
the stored token, `replace` stores the new one, `remove` deletes it, and enabling without a stored
credential is refused. A disabled, rotated or removed credential cannot cancel a request already
sent or revoke a secret already copied by a process; there is no credential getter to do that with.

Sanitized views omit the token, account ID and script name, keeping the target digest, revision,
enabled and credential-presence flags. Identifiers are not a secret input; callers must not put
secrets in project/connection IDs. Invalid stored rows, schema or database fail closed on open and
inside each read or write transaction: validation accepts only the exact connection table and its
SQLite-generated primary-key autoindex, and additional views, triggers, indexes or other schema
objects are refused. SQLite secure deletion is requested, but rotation and removal do **not**
guarantee physical erasure from backups, journal copies, snapshots or storage. **Revocation is
local**: removing the credential here deletes this instance's copy only and does not revoke the
token at Cloudflare, which the owner must do separately. No remote permissions are checked.

## Acceptance criteria

- **CC-1:** synthetic tests cover owner-only updates, default-off state, exact-target digest and
  secret-free views; invalid authorities cannot be supplied
  (`tests/server/cloudflare-connection-store.test.ts`).
- **CC-2:** separate SQLite handles and a restart reject stale revisions after rotation and
  disabling; credential removal and enabling without a credential are checked.
- **CC-3:** disposable tests cover mode restrictions, project-root refusal, invalid rows and corrupt
  files, plus unexpected views, triggers and indexes on reopen and schema changes through another
  handle while open. These are local tests, not adversarial filesystem or physical-erasure evidence.
- **CC-4:** the installed route is tested end to end with a disposable root and a real listener:
  owner authentication, untrusted Host, foreign origin and a hosted write without the session CSRF
  token are refused; the disabled switch answers `503` and creates no credential directory; a stale
  revision is `409`; no response or captured log line contains the token, account id or script name;
  a configured credential survives a restart and is reused by `keep`; and the agent scope
  vocabulary and harness capability set are unchanged (`tests/server/cloudflare-connection-http.test.ts`).
- **CC-5:** no provider request, deployment, token getter, connection listing or agent tool exists
  for this record. The route and the store are the whole surface; nothing consumes the credential.

## Delivery and user documentation

Implemented locally, not released. It is an owner API with no interface control, and independent
review is required before any integration consumes the record. To use it, an instance started with
`DASHBOARD_CLOUDFLARE_CONNECTION=on` accepts, with the same session token (local mode) or Access
session plus CSRF token (hosted mode) as every other route:

```
GET  /api/projects/<project uuid>/cloudflare-connections/<connection id>
POST /api/projects/<project uuid>/cloudflare-connections/<connection id>
     {"revision":0,"target":{"accountId":"<32 hex>","workerName":"<script>"},
      "credential":{"kind":"replace","token":"<token>"},"enabled":false}
```

Expected result: `200` with the sanitized view at the new revision, and the record readable after a
restart. Troubleshooting: `503` means the switch is off or the credential storage is unavailable or
corrupt (nothing was read or written); `409` means another write reached a newer revision, so reload
the view and send its revision; `422` means the body, target, token or `keep`/`enable` combination is
not one this route stores. A token sent beside `keep` instead of `replace` is refused rather than
silently ignored, and a `keep` write never reads or repeats the stored token.

Before a future caller can use this store it must separately establish authenticated configuration,
safely resolve target and connection revisions, server-derived project/agent scope, revocation
checks immediately before dispatch, transport containment, response bounds, interruption/retry
semantics and recovery. Even those checks cannot make an in-flight request revocable. The
configuration route does not promise atomic isolation from an untrusted same-UID process.
