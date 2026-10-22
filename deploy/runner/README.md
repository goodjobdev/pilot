# The coding runner's container

This directory holds the image a bounded coding job runs in, and how to build and verify it. The
runner's model, its fail-closed rules and its honest limits are in `docs/RUNNER.md`; this page is only
the deployment half.

## Build it

    docker build -t pilot-runner:1 deploy/runner

The image is deliberately bare: Node (for the `test-run` recipe), coreutils (for the `noop-probe`
recipe) and a non-root user at `10001:10001`. It carries no source, no credentials and no default
command — the broker passes the recipe's own argv explicitly.

Pin what you deploy: tag it per release (`pilot-runner:<release>`) and reference that exact tag in
`DASHBOARD_RUNNER_IMAGE`. The image name is configuration, never a request field.

## Enable the runner

    DASHBOARD_RUNNER=on
    DASHBOARD_RUNNER_IMAGE=pilot-runner:1
    # optional: DASHBOARD_RUNNER_DOCKER=/usr/bin/docker

Then restart the application. With the switch on, five `runner.*` actions appear in the typed registry
for a project scope (`runner.read`, `runner.submit`, `runner.claim`, `runner.run`, `runner.settle`) and
the owner-only routes under `/api/projects/:id/runner/jobs` answer. With the switch off — the default —
those actions are absent from the registry and the routes refuse with a named reason.

## The container the broker creates

One job, one container, created by this command line (built by the broker, never by a caller):

    docker run --rm --name pilot-runner-<jobId> \
      --network none --read-only --user 10001:10001 \
      --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit <n> --memory <n>b --memory-swap <n>b --cpus <n> \
      --tmpfs /tmp:rw,noexec,nosuid,size=16m \
      --volume <resolved workspace>:/workspace:rw --workdir /workspace \
      pilot-runner:1 <recipe argv>

Nothing else is mounted, and no environment is passed. The broker refuses to run anything unless the
runtime reports every required property and can enforce the job's limits; there is no fallback to
running a job in the application process, in the application container or on the host.

## Verify the boundary, not just the app

    docker image inspect pilot-runner:1 --format '{{.Config.User}}'      # 10001:10001, never root
    docker run --rm --network none --read-only --user 10001:10001 --cap-drop ALL \
      --security-opt no-new-privileges pilot-runner:1 id                 # uid=10001, gid=10001
    docker run --rm --network none pilot-runner:1 /bin/sh -c 'getent hosts example.com || echo "no dns"'
    docker run --rm --read-only --tmpfs /tmp:rw pilot-runner:1 /bin/sh -c 'touch /nope || echo "root is read-only"'
    docker run --rm -v "$PWD/ws:/workspace:rw" -w /workspace pilot-runner:1 node --test

Then submit a `noop-probe` job from the owner UI (or `POST /api/projects/:id/runner/jobs` with
`{"recipe":"noop-probe","workspace":"."}`), claim it, run it, and confirm the result holds
`succeeded`, exit code 0 and the output `pilot-runner-probe`. That proves the image, the mount and the
whole lifecycle before a longer `test-run` job is trusted.

## The honest limits of this boundary

- **The application needs runtime access to start a container.** The docker group (or a narrowly
  scoped socket proxy) is effectively root on the host. The container bounds the *job's* code, not the
  application: do not enable the runner on a host whose other data you are not willing to expose to
  this application.
- **The capped application container in `deploy/pilot/` has no docker socket on purpose**, so the
  runner cannot work from inside it. Enable the runner only where the application process can reach a
  runtime: on the host, or with an explicitly configured and reviewed socket proxy.
- **This is containment, not a virtual machine.** A container escape or a runtime vulnerability is
  outside what this image or this build can promise.
- **This is a testing environment.** The runner is enabled on the Oracle VPS as a testing environment
  for this work; it is not a hardened multi-tenant execution service, and the application is still
  single-owner with no roles and no rate limiting.
- **A job writes inside its workspace.** That is what a test run does. Point `workspace` at a project
  whose contents you are willing to have modified, and inspect the workspace after an `attention` job.
