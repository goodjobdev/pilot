# Capped pilot container

A single development container for the documentation layer, used before anything
touches a real project. It is deliberately narrow:

| Boundary | Setting |
|---|---|
| Network | publishes `127.0.0.1:4319` only — no public or LAN listener |
| User | `10001:10001`, no login shell, never root |
| Capabilities | `cap_drop: [ALL]`, `no-new-privileges` |
| Filesystem | read-only root, writable named volume for `/data`, 64 MiB `/tmp` |
| Resources | 2 CPUs, 2 GiB memory, 512 PIDs |
| Host access | no docker socket, no host networking, no production mounts, no SSH keys |
| Logs | json-file, 10 MiB x 3 |

The image contains the built client, the bundled server and production
dependencies only. Nothing in it can start the agent harness yet; that arrives
with the next phase and inherits the same boundaries.

## Use

The compose file runs the container profile, which must be hosted mode with the
container-private-interface exposure (a published port reaches the container's own interface,
never its loopback). Copy the hosted example; the local example is a host-loopback profile for
running the app directly on the host, never inside this container.

```sh
cp env.hosted.example .env          # hosted + container-private-interface
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Replace the `CF_ACCESS_TEAM` placeholder and `DASHBOARD_ORIGIN`/`DASHBOARD_HEALTH_HOST`
hostname with the real Access team subdomain and this pilot's hostname before starting; the
process validates them and refuses to start otherwise. Keep `DASHBOARD_HEALTH_HOST` equal to
the origin host so the compose healthcheck's `Host` header is never empty (an empty or
mismatching Host is a 403).

Verify the boundary, not just the app:

```sh
docker inspect pi-workspace-pilot --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}'
docker port pi-workspace-pilot                     # must show 127.0.0.1 only
docker exec pi-workspace-pilot id                  # must show uid 10001, never 0
docker exec pi-workspace-pilot sh -c 'test ! -e /var/run/docker.sock && echo "no docker socket"'
curl -fsS -H 'Host: pilot-dashboard.example.com' http://127.0.0.1:4319/healthz   # the origin host, not 127.0.0.1
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: pilot-dashboard.example.com' http://127.0.0.1:4319/api/projects   # 401 without a session
```

## Remote access options

Both keep the container on loopback and put a private path in front of it.
Choose one; do not expose the port.

- **Private network (preferred).** Enrol the host in the tailnet, then reach the
  container through the tailnet only, with the app origin set to the tailnet
  HTTPS name.
- **Owner-only Cloudflare Access.** A *separate* Access application and tunnel
  route for this hostname, with the app in `hosted` mode. Never reuse the live
  dashboard's route, policy or audience, and never add a bypass.

## Kill switch

```sh
docker compose --env-file .env stop     # stops the app, keeps its data volume
docker compose --env-file .env down     # removes the container; the named volume stays
docker volume rm pi-workspace-pilot_pilot-data   # only when the pilot data is disposable
```

Stopping this container cannot affect any other service on the host: it shares no
network, no volume and no process namespace with them.
