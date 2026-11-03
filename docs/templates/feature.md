---
title: "Feature specification template"
description: "A reusable contract for documented, designed and verified work."
pilot:
  schema: 1
  id: feature-template
  kind: specification
  doc_status: draft
  feature_status: planned
  verified_release: null
---

## Problem and outcome

Identify the user, their problem, current workaround and observable success. State scope and non-goals. Replace this guidance with concrete requirements; the template itself does not establish implemented behaviour.

## Design contract

Link the design source. Name flows and screen/state IDs. Specify loading, empty, error, permission-denied, conflict and recovery states. Define mobile/desktop behaviour, keyboard/focus operation and accessibility.

## Behaviour and data contract

State prerequisites, actions, permissions, inputs/outputs, validation, canonical files, revisions, side effects, cancellation, concurrency and recovery. Separate a preview from a consequential action. State what never happens automatically.

## Acceptance criteria

Use stable IDs, for example AC-1. For each, provide Given/When/Then behaviour, the automated check where possible, and the manual evidence still required. Cover refusal and recovery paths, not only success.

## Delivery and user documentation

Link plan tasks and dependencies, the how-to/reference pages, implementation and test evidence. Record limitations and rollout/rollback compatibility. Update feature availability only after the stated evidence exists; a local implementation is not a production release.

## Decisions and open questions

Record decisions or link ADRs. Make unresolved questions explicit. Do not silently treat a proposal as accepted.
