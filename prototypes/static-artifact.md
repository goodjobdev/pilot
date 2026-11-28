# Static artifact manifest prototype (uninstalled)

`static-artifact.mjs` is a pure in-memory experiment, not wired to Pilot or a deployment
adapter. It accepts only a bounded array of caller-supplied entries: `{ path, type: 'file',
bytes: Uint8Array }` or `{ path, type: 'directory' }`. No other fields, including mode,
link or ownership metadata, are accepted. Entries must describe regular files and
directories only; the caller must identify their actual type before calling. The prototype
cannot detect a link that the caller misrepresents as ordinary bytes. It does not read paths,
walk a filesystem, decode archives, perform network operations, build or deploy anything.
It does not prove source provenance, a coherent filesystem snapshot, safe archive traversal,
or production deployment safety. JavaScript content is not reviewed or made safe.

Paths are case-sensitive ASCII `[A-Za-z0-9._~/-]`, relative, with nonempty components
other than `.` or `..`. Full and implicit directory paths must not duplicate or collide
under ASCII case folding; a file cannot be an ancestor. Explicit directories may appear
once and are validated but are not represented in the manifest (empty directories have no
release identity). Root `index.html` is mandatory with exactly that spelling. Bounds are
1024 explicit entries, 240 bytes per path, 1 MiB per file and 8 MiB total file bytes.
Proxies, accessor entry slots or fields, and shared-memory byte arrays are rejected;
entry slots and fields must be own data properties. Exact shape validation enumerates all own
keys, so an object with a hostile number of keys can cause proportional allocation. This
prototype is not a bounded or safe boundary for untrusted in-process inputs. The implementation copies each input before hashing,
keeps private copies, revalidates them on each read and returns new copies; callers must
still protect any later copies they use. It does not make sequential input observations an
atomic snapshot.

Manifest v1 is JSON encoded as UTF-8 without whitespace, with keys ordered `version`,
`totalBytes`, `files`, and each file's keys ordered `path`, `size`, `sha256`. Files are
sorted by ASCII/UTF-8 path bytes; digests are lowercase SHA-256 hex. Release ID is lowercase
SHA-256 hex over UTF-8 `pilot-static-artifact-manifest-v1`, a NUL byte, then the exact
manifest JSON bytes. There is no target, attestation or authorization binding.

Run the isolated tests with `node --test tests/prototypes/static-artifact.test.mjs`.
This is not an implementation of the host, trusted builder, provenance, or recovery protocol
proposed in `docs/specs/oracle-static-deployment-investigation.md`.
