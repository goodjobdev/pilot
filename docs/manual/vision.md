---
title: "Vision: Design Documentation Driven Development"
description: "The product purpose and the contract between design, documentation and delivery."
pilot:
  schema: 1
  id: vision
  kind: vision
  doc_status: accepted
  feature_status: partial
  verified_release: fd3fa6f
---

## Product vision

Pilot is a remote harness for documentation-driven development, extended to **Design Documentation Driven Development (DDDD)**. A person should be able to define, inspect, direct and review work from a phone without giving up repository ownership, durable execution or meaningful review.

The guiding principle, quoted by the project owner from Zach Supalla, is:

> From the perspective of a user, if a feature is not documented, then it doesn’t exist, and if a feature is documented incorrectly, then it’s broken.

This is a product policy, not a claim that the current product has complete documentation.

## The DDDD loop

1. **Intent:** describe the user, problem, outcome and non-goals.
2. **Design:** specify flows, screens, states, accessibility and responsive behaviour.
3. **Contract:** define observable behaviour, permissions, data effects and acceptance criteria.
4. **Plan:** create linked tasks, milestones and dependencies.
5. **Implement:** let a scoped agent work against the accepted contract.
6. **Verify:** attach automated checks and review evidence; do not treat a task checkbox as proof.
7. **Document and release:** update the user guide and availability record in the same change.

## Principles

- Markdown in the repository owns intent and specifications. Rendered sites and boards are views, not competing sources.
- A design must describe loading, empty, error, conflict and recovery states, not only a happy-path screen.
- The owner approves consequential actions. Agent scope, progress, uncertainty and limitations must be visible.
- Planned, partially implemented, implemented-but-unreleased and available features are different states.
- A local commit is history, not a remote backup. A passing automated test is evidence, not a claim of real-device acceptance.
- Existing work, drafts, credentials and project isolation take precedence over convenient automation.

## Design direction and non-goals

Design artifacts will become first-class inputs and linked acceptance evidence. A design editor, component authoring and design-to-code workflows remain **planned**. Existing static mockups and diagrams support documentation today. This vision does not authorize arbitrary shell tools, automatic deployment, multi-tenant sharing or replacing the current Svelte application.
