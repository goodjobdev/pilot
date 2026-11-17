---
title: Reusable JSON projections
description: A narrowly scoped agent-created deterministic tool definition.
pilot:
  schema: 1
  id: reusable-json-tools
  kind: specification
  doc_status: draft
  feature_status: implemented
  verified_release: null
---

## Problem and outcome

A bound agent can save a named JSON object field projection and invoke it in a later turn or
session in the same project. This is one fixed built-in operation, not arbitrary Code Mode,
Cloudflare, MCP, executable code, a network client or an integration with credentials.

## Design contract

There is no new screen. An owner uses the existing agent-scope controls and the deployment
switch described in [Agents](../manual/agents.md). An agent sees tool errors for invalid input,
missing definitions, unavailable authority or stale revisions. Definitions are working state in
the control store, not canonical project Markdown.

## Behaviour and data contract

Both the default-off `DASHBOARD_REUSABLE_TOOLS=on` deployment switch and an owner grant of
`reusable_tools` to the bound named agent are required. Unbound owner dispatch is refused even
though legacy owner dispatch normally has unrestricted tools. Project and agent identity come from
the harness binding, never from tool arguments. Fork sessions are refused. Scope and binding changes
are checked at each call; a definition write additionally checks the versioned authority under the
same SQLite transaction as admission. Existing session recovery guards apply.

`reusable_define` takes a lowercase name, previous revision (zero to create), and 1–16 distinct
ASCII field names. It writes a new durable revision; stale revisions conflict. Each agent has at
most 32 names per project and 32 revisions per name. `reusable_list` lists current definitions.
`reusable_invoke` parses an object supplied as a JSON string and returns only the named own
properties, in definition order, with the definition revision. Input and output are each capped at
8192 UTF-8 bytes. Nested JSON values are copied, not evaluated. Every number anywhere in the input must use an integer literal within JavaScript's safe integer range; negative zero, decimals and exponent notation are refused, even if they would round to a safe integer. No code, modules, shell, URL,
network or external effects are available. Do not put secrets in inputs or definitions: tool calls
and results may appear in durable transcripts.

A definition write is a mutation and marked unsafe to replay. Invocation is also conservatively
marked unsafe to replay because the current definition may change after interruption. An interrupted
call is not automatically repeated; inspect the list and transcript before deciding what to do.
There is no automatic retry, undo, delete, host action or guarantee of exactly-once execution.

## Acceptance criteria

- RJ-1: Without the switch and explicit bound scope, no definition or invocation is admitted.
- RJ-2: Project and agent isolation, size and schema bounds, revision conflicts and reopening are
  exercised in `tests/server/reusable-tools.test.ts`.
- RJ-3: A binding ABA race is rejected inside write admission. Disposable subprocess tests kill and
  reopen the harness on both sides of definition admission and invocation; the interrupted call is
  not replayed. They do not establish quiescence of arbitrary processes.
- RJ-4: The model can create and invoke a projection through the application wiring with a faux
  provider. No provider integration or production rollout is implied. Independent review and
  released-instance verification remain.

## Delivery and user documentation

Locally implemented, not released. See [Agents](../manual/agents.md) for opt-in and limitations.
Disable the instance switch to make all definitions unavailable; stored records are retained.
