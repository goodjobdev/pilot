---
title: "Local deploy and publish targets"
description: "An installed, default-off, policy-controlled local deploy and publish capability with exact owner-configured destinations."
pilot:
  schema: 1
  id: local-release-targets
  kind: specification
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

## Scope and availability

This contract describes two **local filesystem** action capabilities that this build installs into
the agent harness: `deploy` and `publish`. They are implemented locally and are **not released**;
`verified_release` stays null until an independent review and a released instance verify them.

They are not Cloudflare, CDN, self-hosted-service or CI/CD deployment. No provider transport,
credential, account, pipeline or domain appears in this change, and no request is made outside the
process. No web server is started, configured or health-checked: a separate server or process must
read the configured directory.

Both are **disabled by default**:

| Tool | Scope | Instance switch |
| --- | --- | --- |
| `deploy_preview`, `deploy_accepted` | `deploy` | `DASHBOARD_DEPLOY=on` |
| `publish_preview`, `publish_accepted` | `publish` | `DASHBOARD_PUBLISH=on` |

A scope granted while its switch is off is reported to the model as granted but unavailable, and the
tool is absent from the harness rather than present and failing.

## Owner configuration

The destination is never a tool argument. The owner configures it through the authenticated,
owner-only, revision-checked route after the same Host, origin and CSRF enforcement as every other
write:

- `GET|POST /api/projects/:id/action-destinations/deploy` — a relative `artifactPath` inside the
  project's connected worktree and an existing real `targetDirectory` under the configured browse
  roots.
- `GET|POST /api/projects/:id/action-destinations/publish` — an existing real `publicationRoot` under
  the configured browse roots.

The route resolves the directory with `realpath` and refuses one outside the approved roots, one that
is a symbolic link and one that does not exist. Each accepted revision is immutable and durable in the
control store, with an audit row; a stale revision is a conflict that writes nothing. Configuring a
destination executes nothing and grants no scope.

## Deploy

`deploy_preview` reads the configured artifact directory. It refuses a symlink at any component, a
special file, an empty artifact, a path over 240 characters, a file over 2 MiB, more than 500 files or
more than 16 MiB total. It returns a sorted SHA-256 manifest digest, the file count, the byte total
and the artifact identity bound to the exact target revision and content.

`deploy_accepted` requires same-session evidence already accepted for that exact bound artifact under
`agent-may-accept` with `deploy` set to `full-auto`. It then:

1. rechecks the destination, the artifact digest and the accepting authority;
2. copies the artifact into an owned `.pilot-staging-…` directory inside the target and reads the
   staged digest back;
3. renames the staging directory to `generations/gen-<digest-prefix>` (immutable and never removed);
4. replaces the stable `current` symlink atomically by renaming a fresh temporary link over it;
5. reads the served content through `current` and requires the same digest;
6. writes a durable outcome naming the generation and the previous generation.

The previous generation is retained for **manual** rollback: an operator repoints `current` at it.
Pilot never rolls back automatically, never deletes a generation and never treats a deployment as a
health check.

## Publish

`publish_preview` accepts 1–500 paths relative to the project's connected worktree and returns each
file's relative path, digest and size beside the bound artifact identity. A path that is absolute,
carries a backslash, an empty/current/parent segment or an unaccepted character, a symlink at any
component, a non-regular file, a file over 2 MiB or a total over 16 MiB is refused before any copy.

`publish_accepted` requires the equivalent accepted artifact under `agent-may-accept` with `publish`
set to `full-auto`, stages the exact files inside the publication root, reads the staged digest back,
renames the staging directory to `publish-<digest-prefix>` with one atomic rename, and reads the
published digest back. An earlier publication is never replaced or removed. A publication has no
rollback pointer; what a server reads is an operator decision.

## Admission, receipts and uncertainty

Both effects run through the existing `AcceptedActionExecutor`. A durable action intent is written
before the effect; a confirmed effect records a receipt and a durable outcome; an interrupted or
unreadable result is reported as **uncertain** with the intent and its resource barrier retained. No
automatic replay exists. A duplicate invocation is refused, and the durable resource key binds the
configured directory **and** the promoted content, so a later generation of the same target is
admissible while replaying the same accepted content is not.

The key does not serialize two different contents targeting one directory: concurrent deployments
can interleave and the last swap wins. This is a local same-UID design, not a transactional
deployment system, lease or provider guarantee.

## Refusals

- no enabled destination, or a destination revision that changed: refused before any copy;
- an artifact or file-list digest that changed since the preview: refused before any copy;
- a destination outside the approved roots, a symlinked destination, a missing directory: refused;
- a `current` path that exists but is not a link this tool created: refused, never replaced;
- a symlinked or non-regular artifact/file: refused;
- `deploy`/`publish` in a fork session: refused, because it would write a parent-owned target;
- an agent without the scope, without a bound agent identity, or without a current full-auto
  acceptance: refused with no effect.

## Honest limits

- The digest proves the bytes this process read and copied; it is not proof of who produced them or
  that serving them is safe. Evidence and acceptance are claims, not provenance.
- A staging directory is briefly visible under the target; a hard crash can leave staging litter
  that is removed manually, not automatically.
- The optional same-UID `shell` can read and write the same directories. Nothing here contains it.
- Copied files are written `0644`: an executable bit in the artifact is **not** preserved, and a
  content digest cannot see a mode change. Do not use this to publish programs that must run.
- Nothing stops an owner from pointing the target at the project worktree itself or the data root;
  that is an owner configuration choice, not a containment boundary, and it would place
  `generations/`, `current` and staging directories inside that tree.
- This build does not serve, route, proxy, cache, invalidate or check the health of the result.
- `DASHBOARD_DEPLOY`/`DASHBOARD_PUBLISH` are deployment decisions; the harness settings cannot switch
  them on.

## Acceptance evidence

- **LRT-1:** end-to-end deploy copies the exact artifact, swaps `current`, reads the digest back, and
  retains and records the previous generation on a second deploy
  (`tests/server/local-deploy.test.ts`).
- **LRT-2:** wrong or changed digest, changed target revision, missing artifact, symlink, oversize
  file, unapproved root and disabled destination each refuse with no effect
  (`tests/server/local-deploy.test.ts`).
- **LRT-3:** scope, bound-agent authority and `full-auto` policy each refuse; a duplicate invocation is
  refused without a second promotion; an interruption before the swap is uncertain with unchanged
  served content, and one after the swap is uncertain with no replay (both retain the barrier)
  (`tests/server/local-deploy.test.ts`).
- **LRT-4:** end-to-end publish copies exactly the reviewed files and reads the digests back; a path
  escape, symlink, non-regular file, oversize file, changed file, unapproved root and revoked policy
  are refused with no publication (`tests/server/local-publish.test.ts`).
- **LRT-5:** the owner configuration route is authenticated, origin/CSRF checked, strictly shaped,
  revision-checked, durable across a restart, and reports availability from the instance switch
  (`tests/server/local-destination-http.test.ts`).
- **LRT-6:** the preview tools are installed in the agent harness only for a bound agent whose scopes
  grant them, and are refused at dispatch otherwise (`tests/server/local-release-harness.test.ts`).

All evidence is synthetic and local, over disposable roots. No provider, network, live project,
container or external effect is involved.
