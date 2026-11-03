---
title: "Design in the DDDD workflow"
description: "Document design decisions today without claiming a design editor already exists."
pilot:
  schema: 1
  id: design
  kind: explanation
  doc_status: draft
  feature_status: planned
  verified_release: null
---

## Available building blocks

The Wiki can render Markdown, diagrams, supported images and static HTML/SVG mockups within its existing safety limits. Static mockups do not execute arbitrary scripts. Task specifications can link to these repository artifacts.

## Planned design functionality

An integrated design editor, component authoring, interactive prototyping and design-to-code tooling are not implemented. This page defines direction, not an available feature list.

## Document a design now

For each flow, specify the user, entry point, successful outcome and alternative paths. Include loading, empty, error, permission-denied, conflict and recovery states. Define keyboard operation, focus behaviour, accessible names, responsive layout and reduced motion where relevant.

Keep artifact source in the repository. Give each important screen/state a stable identifier. Link the design to the feature specification and its acceptance criteria; record what changed and why. Screenshots alone are insufficient to define interaction or data rules.

Use the [feature template](../templates/feature.md) and [design template](../templates/design.md). The plan points to these documents instead of duplicating them in task descriptions.
