---
title: "Your first project"
description: "Add a workspace, connect its repository, and create a reviewed plan."
pilot:
  schema: 1
  id: first-project
  kind: tutorial
  doc_status: accepted
  feature_status: available
  verified_release: fd3fa6f
---

## Before you start

You need access to Pilot. For a connected checkout you also need a GitHub repository and permission to add a deploy key. Private repositories use this same deploy-key flow; a GitHub account sign-in or personal access token in Pilot is not required. A read-only deploy key is sufficient for clone and fetch; pushing needs write access, and Pilot does not provide an automatic push workflow.

## Add a project

1. Choose **Add project** and enter a project name.
2. Choose **Managed workspace** for a planning folder on the server. Enter its optional GitHub repository URL.
3. Choose **Confirm & add project**.

A URL alone does **not** download files. An existing server folder is an alternative, limited to operator-approved roots; it is not the same as connecting a managed checkout.

## Download the repository

1. Open **Board actions → Repository & deploy key**.
2. Generate the project deploy key. Copy only its public key to GitHub’s repository settings → Deploy keys.
3. Choose **Check repository access**. This checks read access, not write access.
4. Confirm **Connect repository worktree**.

Pilot clones the repository and opens `work/pilot-<project-id-prefix>` as a separate working branch. Connection itself does not install, commit, push or deploy. It preserves the original planning folder and refuses conflicting files instead of overwriting them.

## Inspect and plan

Open **Workspace → Files** to inspect the checkout, or **Doc** to read Markdown. Choose **Sync plan**, select source documents, preview candidates and explicitly apply tasks and dependency suggestions. Read [planning](./planning.md) for the supported input format.

Document saves and board changes attempt local commits on the Pilot branch. Files copied during connection can still be untracked: review and save/commit those files before a later repository update. Do not assume connection committed them.

## Keep it current

**Reload**, Workspace **Refresh**, and **Sync plan** do not fetch from GitHub. The [remote-update guide](./remote-updates.md) describes the unreleased fetch/review/update workflow. On older releases a repository update needs an operator; the default planning agent has no general Git tool.
