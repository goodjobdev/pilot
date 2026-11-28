---
title: Documentation contract
description: How Pilot keeps design, implementation and user documentation consistent.
pilot:
  schema: 1
  id: documentation-contract
  kind: reference
  doc_status: accepted
  feature_status: implemented
  verified_release: null
---

## Documentation is part of the feature

Read [the DDDD vision](manual/vision.md) before product-shaped changes. A feature is not release-ready without accurate user instructions, design/behaviour contracts where appropriate, and acceptance evidence. Update them with the implementation, not in a later undocumented release.

## Canonical sources and publication

- `docs/manual/`: user tutorials, how-tos, explanations and reference.
- `docs/templates/`: reusable feature and design specification templates.
- `docs/specs/`: concrete feature/design contracts with acceptance IDs.
- Existing engineering/operations documents remain at their stable paths. Historical implementation notes are not user instructions or current feature acceptance.
- `docs-site/pages.json` is the explicit publication allowlist. `docs-site/.generated/` and `docs-site/dist/` are disposable output, never edited or committed. The site is a view of Markdown, not a second source.
- Never publish runtime `docs/dashboard`, registered project content, private operations, credentials, transcripts, host/account identifiers or deployment evidence. Do not glob all project documentation into a public site. Starlight `draft` and `sidebar.hidden` are presentation controls, not access control.
- Plain Markdown is the portable source format. Do not add executable MDX to repository-authored user documentation. Design assets need an explicit reviewed publication path; external images are not silently fetched into the site.

## Version-1 frontmatter

Published pages require Starlight `title`, `description` and a namespaced `pilot` object:

```yaml
---
title: Update a repository
description: Review incoming changes before updating files.
pilot:
  schema: 1
  id: repository-updates
  kind: how-to
  doc_status: draft
  feature_status: planned
  verified_release: null
---
```

`id` is a stable, unique lowercase identifier. `kind` is `tutorial`, `how-to`, `reference`, `explanation`, `vision`, `specification`, or `design`. `doc_status` is `draft`, `review`, `accepted`, or `deprecated`. `feature_status` is `planned`, `partial`, `implemented`, `available`, or `deprecated`.

`implemented` means built locally but not released; `available` requires an explicit `verified_release` reference and user-facing instructions checked against that release. An accepted specification may describe planned functionality. `verified_release` names evidence for the documented behaviour; it is not automatically updated from the site build date. Do not add invented review dates. Templates intentionally remain draft/planned.

This editorial schema does not apply to the canonical runtime board, legacy engineering documents or arbitrary registered project files. The runtime plan already has its own strict schema. Never inject Starlight fields into its frontmatter.

## Document shapes

Use the [feature](templates/feature.md) and [design](templates/design.md) templates for contracts. How-tos need prerequisites, exact steps, expected results and troubleshooting. Reference pages enumerate actual controls, effects, defaults and limitations. Tutorials provide a complete, reproducible path. Explanations teach concepts without disguising proposals as delivered behaviour.

Give acceptance criteria stable IDs. Link design states and tests to them. Link tasks to specifications, rather than copying the specification into task descriptions. Keep the source path stable or update every inbound link when moving it.

## Definition of done

1. The product/design intent and non-goals are explicit.
2. The behaviour, permissions, file/data effects, cancellation, conflict and recovery rules are documented.
3. Automated evidence covers success and refusal paths; manual evidence is identified honestly.
4. User guides and setting references match observable controls and messages.
5. Page metadata, source links, anchors and site build pass validation.
6. Availability accurately distinguishes local implementation from a deployed release.

CI checks cannot prove prose correctness. A reviewer must compare the feature with its instructions. Broken instructions are a product defect.

## Working on the site

The Starlight app is isolated in `docs-site/`; its dependency lock does not replace Pilot's root lock or add Astro to the runtime image. Run its commands from that directory. The preparation step validates the allowlist/schema/links and creates generated content from canonical Markdown. Both `check` and `build` run preparation first. The static site is not automatically deployed by the application build.
