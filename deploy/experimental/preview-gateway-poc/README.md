# Preview gateway packaging POC

Source-only, opt-in packaging experiment. It is not part of Pilot's normal container image or
service, and no Compose overlay is installed. Do not build/enroll/deploy it
or use it against a live tailnet as part of ordinary Pilot operation.

This Go + Node gateway is for a separately authenticated terminal-dev-server preview site. It is not
the dashboard identity proxy in `../tailnet-dashboard-proxy-poc/`. It has no `TS_AUTHKEY`, live owner,
node IDs, hostname, certificate or key material in this source. Initial enrollment and persistent
state provisioning are not solved. The source expects explicit site/port/node/UID configuration,
protected key/certificate/state paths, a dedicated non-root gateway UID, and independently reviewed
network policy. The documented same-UID terminal limitation remains: sharing the dashboard network
namespace is not process isolation, and Pilot terminal code can access resources available to the
Pilot UID.

The package includes Go/Node source, Dockerfile, gateway Node lockfile and Go module inputs. Its source
expects verified immutable image references, architecture-specific native dependencies, explicit
Compose init/supervision, and operational handling when dashboard recreation changes its shared
network namespace. No actual enrollment, certificate, gateway startup, browser boundary, upstream
server, resource/recovery behavior or deployment is asserted as verified here. Static test source is
included but has not been run in this integration worktree. See
`docs/specs/terminal-preview-design.md` and `../README.md`; independent security review and owner
approval are prerequisites to any use.
