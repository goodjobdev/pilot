# Security model

Pilot is built for one owner on a private host. This page states what it protects, what it
assumes, and what it does not protect, so you can decide whether that fits.

## Assumptions

- The host, its filesystem and the operator are trusted. Root on the host is game over.
- The projects you register are yours, and their content is trusted enough to render.
- Authentication is provided by an identity-aware proxy in front of the application, or by
  local mode on a loopback interface you control.

## What is protected

| Concern | How |
|---|---|
| Access | The application verifies the signed assertion itself — signature, issuer, audience, expiry and the allowed owner — rather than trusting identity headers. No bypass mode, no anonymous route |
| Cross-site writes | Session-bound CSRF plus same-origin and JSON content-type checks |
| Host confusion | The Host header must match the configured origin |
| Exposure | `host-loopback` — the default, and the only profile local mode allows — binds `127.0.0.1`. A container may bind its own interface only with hosted mode plus `container-private-interface`, which serves the published port inside its private network namespace; the host still publishes on `127.0.0.1` only, and the surrounding network stays an operator-attested fact |
| Path escape | One containment helper refuses absolute paths, `..` and symlinks; generated folders and app-managed paths are never served or edited |
| Resource abuse | Read and write size caps, a document-count cap, a bounded subscription list, and bounded search/inbox scans |
| Untrusted rendering | Markdown is sanitised; assets are limited to images and static HTML/SVG; mockups render in a sandboxed frame with no scripts and no same-origin access; a strict Content-Security-Policy covers the application |
| Agent execution | The question/note tools remain scoped. The explicitly opt-in `DASHBOARD_TERMINAL=on` additionally enables an interactive owner terminal and the independently scoped agent `shell` tool; both run as the Pilot service user with its environment and filesystem permissions, and the project is only the initial cwd. No shell confinement is claimed. |
| Credentials | Provider credentials and project deploy keys live outside project roots in 0600 files/0700 folders, excluded from ordinary backups; settings reads return status/public keys only. Login and Git failures do not echo raw credential response bodies or command output |
| Host escape | The container drops all capabilities, runs non-root with a read-only root filesystem, has no Docker socket and no host mounts |

## What is not protected

- **A compromised host.** Anything with root or the data directory can read every project and
  every session.
- **Agent behaviour inside a project.** An agent may write to the workspace you registered.
  Bounded tools are not a sandbox: register directories you are willing to have modified, and
  run the application in a container rather than on a workstation.
- **Same-container shell access.** Secrets are not encrypted at rest. Code running as the
  application user can read provider credentials and deploy keys; these are not per-agent
  sandboxes. Write deploy keys are repository-scoped, not branch-scoped. The terminal and agent
  shell are off unless explicitly enabled with `DASHBOARD_TERMINAL=on`; enabling either is broad
  same-user execution, not a separate execution boundary. Non-interactive shell calls cap runtime
  and output and escalate process-group termination from SIGTERM to SIGKILL; shutdown does the same
  for interactive terminals. A command that deliberately daemonizes or escapes its process group
  may outlive Pilot, so this is process cleanup, not containment. Use provider budgets, GitHub
  repository rules and an external execution boundary before opting in.
- **Multi-user abuse.** There is one owner, no roles, no quotas and no rate limiting. It is not
  multi-tenant.
- **Backups.** They deliberately exclude credentials, alert keys and agent sessions. Treat a
  backup as documentation, not as a full restore of the working state.
- **The proxy in front.** If you use a third-party tunnel or proxy, that operator sees the
  traffic it forwards. Self-host the relay or keep it on a network you control.
- **A stolen unlocked device** with an active session, and any credential you paste into a
  chat, log or image.
- **Project dev-server previews are unavailable.** A same-origin proxy would risk bypassing owner
  authentication and executing SVG or other active content in the application origin. No preview
  content is served until a separate-origin design with owner-authenticated proxying is implemented
  and verified.

## Reporting

This is a personal project without a security team. If you find a problem, open an issue that
describes the impact without including live credentials or private data.
