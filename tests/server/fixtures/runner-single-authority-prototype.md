# Synthetic single-authority dispatch/close experiment

This is uninstalled test-only code. It does not call, wrap, replace, or fence any of
Pilot's existing runtime, supervisor, broker, transport, policy, or budget paths. Its
only simulated runtime effects append strings to an in-memory array. The synthetic
request is only a three-field test envelope, not the real complete service request.

For this closed model, one SQLite transaction decides close versus admission and
holds a permanent global dispatch barrier. Only the initial winning call owns a
non-recoverable continuation. Before each simulated create/start, that continuation
commits its next intent after checking the same row. Close-first survives an ordinary
reopen and blocks delayed delivery; dispatch-first is always reported as possible,
even when its continuation is paused or dead. No timeout, close, inspection, or
completion releases the barrier. Tests exercise separate processes and SIGKILL at
selected gates, but not physical power loss or all scheduling and failure states.

This does not provide protected journal identity, existence or freshness: deletion,
replacement, rollback, tampering, corrupt schemas and hostile database writers are
not handled reliably. SQLite durability settings and recorded stages do not prove
runtime termination, freshness, external quiescence or safe host execution. There is
no authentication, capacity limit, policy/budget enforcement, real runtime identity,
termination receipt, service interface, or independently protected anchor. Do not
interpret tests as covering existing runtime paths or permission to deploy. See
`docs/specs/runner-arbitration-supervisor-investigation.md` for prerequisites.
