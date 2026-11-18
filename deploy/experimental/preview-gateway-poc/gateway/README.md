# Preview gateway core source

This Node core is part of the separate terminal preview gateway experiment. The private entrypoint is
Linux-only and requires protected service-owned paths, a non-root gateway UID distinct from the Pilot
UID, a mode-0600 Unix socket, and the Linux `SO_PEERCRED` addon. Missing credentials or unsupported
platforms fail closed; trust is not inferred from an empty remote address. It remains disabled and
unreviewed for production use. See the parent experimental POC README.
