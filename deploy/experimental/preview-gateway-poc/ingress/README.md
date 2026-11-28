# Go tsnet ingress

This is the Go side of the isolated bridge prototype. `Protect` resolves each
request/upgrade using the tsnet node's LocalAPI WhoIs. `UnixForwarder` strips
untrusted identity headers, signs a fresh request-bound Ed25519 assertion,
forwards only to the protected Node Unix socket, and validates Linux
`SO_PEERCRED` for each socket connection.

## Addressing

Previews are served on the gateway node's **own tailnet name**, one port per
preview: `https://<node>.<tailnet>.ts.net:<port>/`. The node name is read from the
tsnet LocalAPI status at startup and must be a `*.ts.net` name; the certificate
comes from Tailscale for that exact name, it is re-validated per handshake, and
any other SNI is refused. There is no wildcard certificate, no owner-supplied PEM,
no public DNS record and no Funnel.

`PREVIEW_PORTS` lists the listener ports (comma-separated, unprivileged, at most
32, excluding 443/22/4319). HTTP `Host` must be exactly the node name, and the
only accepted port is the listener's own port, so a request for one preview cannot
be redirected to another port on the same name.

## Trust boundary

- Key access uses Linux `O_NOFOLLOW` plus `fstat`; unsafe paths, UID mismatch, and
  unsupported OS fail closed.
- tsnet state, assertion key, and socket parents must be service-owned and
  private; ancestors must not be group/other writable.
- The private socket must be mode 0600 and is validated per connection.

See [`../README.md`](../README.md) for the security boundary and strict
disposable Linux ARM64 cross-process test instructions. No deployment or
production security claim is made.
