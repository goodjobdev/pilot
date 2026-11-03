---
title: Composer limits, attachments and thinking contract
description: What the message box accepts, where attached files go, and how thinking is chosen.
pilot:
  schema: 1
  id: composer-contract
  kind: specification
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

# Intent

A person writes long things. A prompt box that refuses a long paste, hides where a file went, or
offers no way to ask for more reasoning is a box that gets in the way of the work.

# Contract

**Messages.** One message may hold up to 200,000 characters. Past 8,000 the interface offers, and
does not force, **Save as document**: the text is stored and the message names its path. Past the
maximum the composer refuses before sending, names the limit, and keeps every character in the box.
The server answers an over-large message with the limit named, never a schema envelope.

**Attachments.** Any file can be attached. It is written into the project's **connected repository
worktree** under `docs/uploads/<generated>-<sanitised name>` — exclusively, as a regular file, with
the name unable to choose a path, and with the size capped before a byte is written. The message
carries one line naming every stored path, so an agent reads them through its own contained read.
Attachments are **uncommitted**: they appear in Workspace → Changes and nothing commits or pushes
them. A project with no connected worktree is refused with that reason.

**Thinking.** A session's thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
or the host default) is chosen in the composer, stored on that conversation, and reported back by
the session view. It cannot be changed while the session is working.

**Turns.** One dispatch may make `DASHBOARD_MAX_MODEL_TURNS` model requests in a row (whole number
1–100, default 40, refused rather than clamped when out of range). The refusal names the bound and
says that sending another message continues.

# Not promised

Attachments are not scanned, converted or executed, and a model that holds neither `file_read` nor
`file_edit` cannot open one: the message names a path it cannot reach. The interface says that the
files were saved for an agent to read; it does not claim the model itself received their bytes.

# Acceptance

| ID | Evidence |
| --- | --- |
| AC-1 | A name cannot choose a path, an empty or oversize body is refused before writing, and a project with no worktree is refused. |
| AC-2 | A stored attachment is a regular file inside the worktree, with one generated name. |
| AC-3 | A symlinked uploads directory is refused and nothing is written through it. |
| AC-4 | The message names every stored path. |
| AC-5 | The composer offers the document action past the threshold, refuses past the maximum, and keeps the text. |
| AC-6 | The thinking level is chosen per session and reported back by the server view. |
