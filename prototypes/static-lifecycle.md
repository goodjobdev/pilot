# Static lifecycle experiment — blocked, uninstalled

This isolated test model uses only an injected synthetic helper and disposable SQLite stores. It is not imported by the application and cannot deploy. Its input hashes are opaque claims: there is no artifact ingestion, provenance, trusted target configuration, network, health check, rollback, reconciliation, or host implementation. It does not establish helper containment, real host identity, filesystem durability, or deployment safety.

A SQLite unique resource row arbitrates cooperating connections sharing the same intact database and identical synthetic resource key. It is written before any fake call and is deliberately never released, even after success or refusal. An operation ID is also unique. Each fake effect is preceded by a persisted unknown state; lost or malformed replies cannot trigger replay. A target change after staging stops activation, but cannot revoke a call already in flight. The fake activation must itself perform the expected-active/generation comparison; this model cannot enforce helper behavior.

**Blocker:** this is not sound deployment arbitration. No trusted canonical host/root identity prevents aliases or independent stores, and a missing, restored or rolled-back database can erase the barrier without detection. SQLite persistence here is not proof of physical durability or atomicity with an external helper. There is no authoritative helper journal, exclusive writer, authenticated reconciliation, or safe barrier recovery. Keep deployment disabled; resolving these requires a separately designed and reviewed external authority and restore-detection protocol, not a timer or an automatic retry. The permanent barrier intentionally sacrifices availability and is not a recovery design.

Run the isolated prototype tests explicitly from the repository root with Node 24+:

```sh
node --test tests/prototypes/static-lifecycle.test.mjs
```

The normal `pnpm test` command does not include them. Process tests use disposable databases, IPC gates and synthetic effects; they do not simulate power loss, storage rollback, hostile writers, or a real external helper.
