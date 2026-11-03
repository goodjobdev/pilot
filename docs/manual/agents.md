---
title: "Agents, permissions and evidence"
description: "Understand what a planning agent can actually do."
pilot:
  schema: 1
  id: agents
  kind: explanation
  doc_status: accepted
  feature_status: available
  verified_release: fd3fa6f
---

The default scripted provider is free and synthetic. Real providers require configuration and explicit opt-in. Tests and examples must not be described as billed-provider acceptance.

A project conversation is durable; named sessions add identity and links. An agent binding and its explicit scopes decide tool availability. Granting a vocabulary item does not install an absent tool. Default planning tools read contained Markdown and the board, ask questions, append notes, and apply revision-checked planning batches. They are not a complete coding toolchain or a general shell/Git endpoint.

Use **Agents and privileges** for bindings, scopes and models. Use **Workers** for bounded owner-created runs, whose reports are untrusted evidence rather than accepted work.

## Review work, not just messages

Link tasks to real specification paths. Ask for acceptance evidence. Inspect the saved files and local history. An assistant saying “done” is not proof of a commit, remote push, passing check or deployment.

## Stop and uncertain work

Stop cancels current execution and withdraws queued input where supported; it does not roll back an existing effect. An uncertain interruption blocks further model/tool work until the owner reviews the original conversation and affected files and explicitly acknowledges the settled state. Acknowledgement does not replay or undo the tool. Do not use Retry to guess whether an unsafe action happened.

Repository updates are explicit owner controls, not a newly granted agent Git scope.
