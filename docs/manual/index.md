---
title: "Pilot documentation"
description: "Understand Pilot and start documentation-driven work."
pilot:
  schema: 1
  id: manual-home
  kind: explanation
  doc_status: accepted
  feature_status: available
  verified_release: fd3fa6f
---

Pilot is a remote harness for **Design Documentation Driven Development (DDDD)**. Keep intent, design, specifications, plans and implementation evidence together, with Markdown in the repository as the source of truth.

Start with [the vision](./vision.md), [your first project](./first-project.md), and [the workspace settings reference](./settings.md).

## What is available

Repository connection, the Wiki, task boards, bounded agent planning tools, session recovery, local documentation commits, and file/change previews are available in the workspace release based on `fd3fa6f`.

[Remote updates](./remote-updates.md) are an unreleased addition. A design editor is planned, not available. Existing diagrams, images and static mockups are documentation assets, not an interactive design application.

## Two kinds of synchronization

**Git updates** bring remote repository changes into the server checkout. **Sync plan** proposes task changes from documents. They are different actions; neither silently rewrites specifications.

## Trust and publishing

Pilot is single-owner software. Keep it behind its authenticated access boundary. This documentation site publishes an explicit list of reviewed project documentation, never registered project content, runtime plans, private operations or credentials.
