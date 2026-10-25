# Local runner validation

## Scope

The first local acceptance check passed on 2026-10-24 against the implementation after `f278afb` and
`a3c4222`. Independent review then required endpoint, deadline, cleanup and sentinel corrections.
The revised acceptance check **passed on 2026-10-25**, including the corrected sentinel assertion.
The operator explicitly approved an empty temporary Docker configuration for the public-image build
only. The build used the verified local endpoint, did not change normal settings and used no saved
credentials. The acceptance check then used the normal Docker configuration. A separate SIGTERM
check confirmed that the supervisor cleans up an interrupted invocation.

Before that approval, the revised image build waited in the user's credential helper and stopped at
its 90-second deadline. The acceptance script correctly refused the absent image before allocation.
That blocker is now resolved for this validation; the user's credential-helper configuration is unchanged.

The first check used Docker Desktop Engine 28.5.1 and the unmodified
`deploy/runner/Dockerfile`, based on `node:24-bookworm-slim`. This is a local runtime result,
not a deployment result or a hostile-code security certification.

The operator approved starting Docker Desktop and downloading the base image. The check used
only disposable synthetic project and data roots. It opened no provider, live project or remote
infrastructure. It installed no dependencies. No service listener or application deployment was needed:
the script exercised the real broker, real Docker port and durable control store directly.

## Repeat the check

First select and explicitly approve a local Unix runtime socket. Verify the current Docker context
and `DOCKER_HOST`, if set, both refer to that exact socket. Refuse TLS overrides rather than bypassing
them. Verify the endpoint is a Unix socket before building anything. Build a unique local image using
an explicit `docker --host unix://<approved-socket> build ...` invocation. Keep the user's Docker
configuration; do not silently replace it to avoid a credential helper. Bound a background build and
its process group separately; this review used a 90-second build deadline.

### Explicitly approved anonymous public-image build

The 2026-10-25 retry used this procedure:

1. Read the selected context with `docker context inspect` using normal settings. Apply
   `checkLocalSelection` and `verifySocket` before allocating the temporary configuration. Confirm
   the runtime answers through the verified endpoint and the unique validation image tag is absent.
   Record the existing image tags so cleanup does not remove pre-existing images.
2. Create a disposable directory with `mkdtemp`. Write only `{}` plus a newline to `config.json`
   inside it, with file mode 0600. Do not copy or read saved credentials.
3. For the build subprocess only, set `DOCKER_CONFIG` to that directory. Remove `DOCKER_CONTEXT`
   and `DOCKER_HOST` routing aliases only after their selection passed verification. Preserve all
   other environment settings; refuse TLS overrides through the safety helper before this step.
4. Recheck the socket's canonical path, then start this exact build argv as a supervised process group:

   ```text
   docker --host <verified-unix-endpoint> build -f deploy/runner/Dockerfile -t <unique-local-tag> .
   ```

   The working directory is this worktree. A 90-second timer kills the build process group on
   expiry; SIGINT/SIGTERM does the same. Background status checks use 60–120-second outer bounds.
5. On subprocess exit, remove the timer and temporary configuration in cleanup. The build completed
   successfully before the deadline. No global Docker setting was changed.
6. Run acceptance without the temporary `DOCKER_CONFIG`; keep the explicit socket and image inputs.
   After all checks, remove only the newly created validation tag and newly downloaded base-image
   tag. Do not prune global runtime state.

This is an explicit, operator-approved exception for an anonymous public-image download, not a silent
fallback in the acceptance script. The acceptance script does not implement or enable this exception.

Then run:

```sh
PILOT_VALIDATE_DOCKER_SOCKET=<approved-absolute-socket> \
PILOT_VALIDATE_RUNNER_IMAGE=pilot-runner:local-validation \
pnpm exec tsx scripts/validate-runner-local.ts
```

Use a 120-second outer command bound. The acceptance supervisor allows 60 seconds total for preflight
and worker execution, followed by a cleanup reserve ending at 85 seconds from start. A hard timer
exits nonzero at 85 seconds and reports retained evidence if cleanup is incomplete. Runtime calls
from the supervisor and polling calls are limited to 2 seconds or the remaining phase budget,
whichever is smaller. Broker calls use a verified wrapper with at most 20 seconds per call and never
more than the remaining work budget. The supervisor kills the worker process group at the work
deadline or on SIGINT/SIGTERM, including its Docker clients, before cleanup. SIGKILL and host failure
cannot run cleanup and remain operator recovery cases.

Before resource allocation, the supervisor verifies the selected context, environment, socket,
runtime and image. A redirect or mismatched context fails closed. Every execution and cleanup call
uses the verified endpoint through explicit `--host`, including the broker's Docker port. Routing
aliases are removed only after they have been verified to match; the user's `DOCKER_CONFIG` stays
unchanged. The wrapper checks that the socket still resolves to the verified socket path.

The script never builds, pulls, installs, configures a provider or starts the application. It creates
only synthetic roots. A supervisor-owned ledger records container names before execution. Cleanup
removes only those names and queries the runtime to confirm absence before deleting mounted roots.
Removal refusals are counted and reported; only confirmed absence makes an already-removed container
harmless. If removal or status cannot prove absence, cleanup fails nonzero and retains the ledger and
roots for inspection. Remove only the image tag created for this check; never prune the runtime.

## Observed results

| Check | Actual result |
|---|---|
| `noop-probe` | Settled successfully with exactly `pilot-runner-probe` and a newline. |
| `test-run` success | Synthetic containment tests passed under the allowlisted `node --test`. |
| `test-run` failure | Deliberately failing synthetic test settled as `failed`. |
| Output truncation | More than 40,000 output bytes were counted; stored output stayed within the 256-byte escaped-record cap and `truncated` was true. |
| Timeout | A container observed running was stopped at the 2,500 ms job limit; result was `timed-out`, with a null exit code. The container disappeared. |
| Durable reopen | All 5 complete job records remained identical after closing and reopening SQLite. Reconciliation changed nothing. Every replay attempt was refused as terminal. |
| Cleanup | The revised supervisor confirmed all 5 allocated containers absent, reported 0 removal refusals and removed the disposable roots. |
| SIGTERM | A separate invocation received SIGTERM 1,200 ms after the probe-settlement progress message. It exited nonzero, confirmed both allocated containers absent, reported 0 removal refusals and removed the roots. |

The Node default test reporter sends fixture `console.error` through TAP stdout. The first acceptance
attempt incorrectly expected the Docker stderr counter to increase. The assertion was corrected.
This was a fixture assumption, not a broker defect. The check still bounds both stored stream fields;
the existing synthetic-port unit tests cover independent stdout and stderr truncation.

## Actual containment evidence

The check inspected the real success container while it was running. It asserted:

- Network mode `none`; no privileged mode.
- Explicit user `10001:10001`; read-only root filesystem.
- Capabilities dropped: `ALL`; security option: `no-new-privileges`.
- Exactly 1 host bind mount, the disposable workspace at `/workspace`, read-write.
- No additional bind or volume mount, no runtime socket mount.
- `/tmp` tmpfs configured as `rw,noexec,nosuid,size=16777216`.
- Memory and memory-plus-swap: both 268,435,456 bytes.
- CPU: 1,000,000,000 NanoCPUs; PID limit: 64.

Inside the real test container, synthetic tests independently confirmed:

- UID and GID both 10001, zero effective capabilities and `NoNewPrivs: 1`.
- cgroup v2 memory limit 268,435,456, swap limit 0, PID limit 64 and CPU quota `100000 100000`.
- `/tmp` mount options include `noexec`, `nosuid` and `size=16384k`.
- Writes to `/etc/pilot-synthetic` fail with a read-only or access-denied error.
- The revised fixture attempted the actual absolute host path of the synthetic sibling sentinel,
  which existed outside the mounted workspace. The read failed with `ENOENT`. The earlier
  `/outside/sentinel` assertion did not test the actual host path and is not used as evidence.
- `/var/run/docker.sock` is absent.
- Workspace and tmpfs writes succeed.
- The only network interface is `lo`. A TCP connection to documentation-only address `192.0.2.1`
  fails promptly with `ENETUNREACH`; it sends no application payload and contacts no real service.

`--network none` retains isolated loopback. The former statement that it provides no interface at all
was inaccurate; `docs/RUNNER.md` now states the observed property.

## Automated checks

- `pnpm exec tsx --test tests/server/runner-broker.test.ts`: **9 passed**.
- `tests/server/runner-validation-safety.test.ts`: **6 passed** after review. These cover local
  selection and security-setting refusals, non-socket rejection, deadline budgeting, ledger name
  validation, cleanup limited to allocated names and cleanup failure reporting.
- `pnpm test`: **398 passed** after review, no failures, skips or cancellations.
- `pnpm check`: **0 errors, 0 warnings** after review.
- Explicit `tsc --noEmit --strict --skipLibCheck --target ES2023 --module ESNext
  --moduleResolution Bundler --esModuleInterop` check of both acceptance entry files: **passed**.
- Revised acceptance with both `PILOT_VALIDATE_DOCKER_SOCKET` and `PILOT_VALIDATE_RUNNER_IMAGE`
  supplied: **all assertions passed on 2026-10-25**. These include local endpoint preflight,
  live-container inspection, actual host sentinel denial, timeout removal and durable non-replay.
- Separate live SIGTERM invocation: **passed**, including nonzero exit and confirmed cleanup.
  This was a manual orchestration check, not an additional test in the default 398-test suite.
- `git diff --check`: **passed**.

## Blockers and limits

The initial build waited in Docker's desktop credential helper before downloading the public base
image. That build was stopped. The first check used an anonymous build. After independent review,
a build that kept normal settings again waited in the helper and stopped at 90 seconds. The operator
then explicitly approved the narrowly scoped anonymous procedure above. It succeeded against the
verified local endpoint. There is no remaining validation blocker, and the credential helper itself
was not changed. No credential value was read, supplied or stored by the validation script.

After the successful check and SIGTERM check, all 7 allocated container names were confirmed absent.
The invocation roots, anonymous-build configuration, validation image, newly downloaded base-image tag
and temporary orchestration files were removed. No pre-existing image or container was removed.

No runtime defect was found in the exercised cases. This check does not test kernel escape resistance,
CPU or memory exhaustion, a fork bomb, remote deployment, application HTTP authentication or recovery
from a killed broker process. It observes configuration and live cgroup limits without resource stress.
It verifies settled-job durability, not every possible crash window. Runtime-generated system mounts
and image files still exist; the single workspace bind is the only mounted host project path.

The base-image tag is mutable. Repeat this check when the image, runtime or runner code changes.
No commit or publication is part of this validation; independent review must happen first.
