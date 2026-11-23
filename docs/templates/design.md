---
title: "Design specification template"
description: "A reusable contract for flows, visual states and design review."
pilot:
  schema: 1
  id: design-template
  kind: design
  doc_status: draft
  feature_status: planned
  verified_release: null
---

## Design intent

Link the feature specification. Identify the user, context, target outcome and non-goals.

## Flow and state inventory

Give every flow/screen/state a stable ID. Describe navigation, entry/exit, actions, validation, loading, empty, success, error, permission, conflict and recovery states. Specify data preserved when a person moves away or reconnects.

## Layout and interaction

Link repository-owned design sources and static prototypes. Define mobile and desktop layouts, content hierarchy, component variants, long-content behaviour, touch targets, keyboard navigation, focus, accessible names, contrast and reduced motion.

## Review and acceptance

Link design requirements to acceptance IDs and tests. Record reviewer decisions, unresolved questions, screenshots/recordings where useful, and differences between the intended design and implementation. Design approval is not proof that the implementation passed acceptance.

## Change history

Use Git for the authoritative history; summarize consequential decisions here or link ADRs. Do not duplicate full artifacts into tasks.
