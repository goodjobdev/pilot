# Disposable end-to-end harness (not deployed)

Runs the real gateway handler with an injected `WhoIs` in front of a real dashboard server started in
`tailnet-gateway` mode, then asserts the owner path and every refusal. It uses a throwaway Ed25519 key
pair and a temporary data root; no tailnet, no credentials, no production image.

```
go build -o /tmp/e2e ./cmd/e2e
/tmp/e2e -dashboard 127.0.0.1:4319 -server /workspace/dist/server.mjs -state /tmp/data
```

It exits non-zero on any failed check. The recorded run behind this repository's release evidence
reported 16/16 passing checks.
