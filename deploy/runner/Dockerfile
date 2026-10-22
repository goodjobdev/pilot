# The coding runner's image: the smallest environment one bounded job runs in.
#
# The broker builds the whole command line itself (see src/server/state/runner-broker.ts and
# docs/RUNNER.md): no network, a read-only root filesystem, this image's non-root user, every
# capability dropped, no-new-privileges, no container-runtime socket, exactly one host path mounted at
# /workspace, a bounded tmpfs at /tmp, and hard memory, CPU and PID caps. Nothing in this file can
# weaken that, and nothing in it starts anything by itself.
#
# It is deliberately bare: Node (for the test-run recipe), coreutils (for the no-op probe) and a
# non-root user. No package manager state, no build tooling, no credentials, no source.

FROM node:24-bookworm-slim

# A non-root user, created at build time so the image's own USER and the broker's explicit --user
# agree. The uid:gid pair is the one deploy/runner/README.md and the broker's default name.
RUN useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /workspace \
 && chown -R runner:runner /workspace

# The single job workspace is mounted here by the broker, read-write, and is the only host path the
# container ever sees. The recipe runs with this as its working directory.
WORKDIR /workspace

# A read-only root filesystem still needs somewhere writable for a Node process, and the broker mounts
# a bounded tmpfs at /tmp. HOME points at it, so nothing a job writes lands outside the mount and the
# tmpfs. No other environment is set: this image does not decide how a workspace's own test suite
# behaves (in particular, it sets no NODE_ENV and no CI).
ENV HOME=/tmp

USER 10001:10001

# No ENTRYPOINT and no CMD on purpose: the broker passes the recipe's own argv explicitly
# (for example "node --test"), so the image carries no default command that could run something else.
