# Images and media

What the application accepts as an image, what it does with the bytes, where they are kept, how they
are served, and which model may receive them. The pinned packages already ship the image processor
this uses, so no image library was added.

## Accepted formats and the exact limits

| Rule | Value |
|---|---|
| Accepted formats | JPEG, PNG, WebP — and only the format the bytes actually are |
| Bytes of one image, as uploaded | 4 MiB (`MAX_IMAGE_BYTES`) |
| Pixels of one image, read from the header before decoding | 25,000,000 (`MAX_IMAGE_PIXELS`) |
| Pixels on either side of one stored image, after any resize | 2000 (`MAX_IMAGE_DIMENSION`) |
| Images in one message | 6 (`MAX_IMAGES_PER_MESSAGE`) |
| Base64 the processor may produce for one image | 4,500,000 bytes |

The constants live in one place, `src/shared/images.ts`, and both the server and the composer read
them from there. Everything above the per-image byte cap is bounded again by the application's
8 MiB request-body limit, which answers `413`.

## How the bytes are validated

Validation never trusts a name, a declared type or an HTTP content type. The upload carries the
client's `name` and `declaredType` for display, and both are deliberately ignored.

1. **Magic bytes.** `sniffImageType()` reads the format from the bytes (`89 50 4E 47…` PNG,
   `FF D8 FF` JPEG, `RIFF…WEBP` WebP). Anything else is refused with the reason
   *"Only JPEG, PNG and WebP images are accepted; these bytes are not one."* A text file renamed
   `.png` is refused here.
2. **Declared size.** `readImageSize()` reads the pixel size out of the PNG `IHDR`, the JPEG frame
   header, or the WebP `VP8X`/`VP8 `/`VP8L` header, and the pixel count is checked against
   `MAX_IMAGE_PIXELS` **before** anything is decoded, so a header claiming 30,000 × 30,000 is
   refused without allocating for it. A header that cannot be read is refused as undecodable.
3. **Decoding.** The image is handed to the documented `ImageProcessor`
   (`@earendil-works/pi-durable/images/node`, the Photon-based processor the pinned
   `@earendil-works/pi-durable` package exports; `ImageLimits` from its `./tools` subpath). An
   image the processor cannot decode is refused, never stored: *"These bytes could not be decoded, so
   the image was not stored."* A failure of the processor itself is a refusal too.
4. **Stored bytes are checked again.** The produced bytes are sniffed and measured a second time, so
   bookkeeping is never trusted over the bytes, and the dimensions are checked against
   `MAX_IMAGE_DIMENSION` after any resize.

Each **per-image** refusal carries a stable code — `type`, `bytes`, `pixels`, `decode`,
`dimension`, `metadata` — plus `vision` for a model that cannot take images. A refusal that belongs
to the **message** rather than to one image carries its own code: `unknown-media` for an id that is
not in the store, and `too-many-images` for a message carrying more ids than one message may hold.
Every one of them is refused with a path-free reason, and every one is a `422` on the route that makes
it. Two refusals come from somewhere else and each says so: the **dispatch-time vision** refusal is a
`409` ([Vision](#vision-admission-and-dispatch-both-check)), and a **media container that is not a
usable directory** is a `503` with code `media-container`
([the store](#the-store-layout-immutability-caching)). The composer shows a per-image reason on the
image it belongs to.

## Orientation, metadata, and what is honestly not stripped

The processor returns an image **unchanged** when it is already upright, in a format providers take
inline, and within the limits; it **re-encodes** the image when it is not.

- **Re-encoded images carry no metadata at all.** The processor encodes from decoded pixels, so
  EXIF, GPS, ICC profiles and comments are gone. The upload reports this: `reencoded: true` and a note
  such as *"resized to 2000×8; EXIF removed by re-encoding"*.
- **Orientation is a per-format fact, and it is stated here per format.** Orientation is applied only
  where the format and the processor actually carry it, so no orientation is claimed for a format
  that does not:
  - **JPEG is the case where it applies.** A JPEG carries its orientation in an Exif APP1 segment, the
    processor reads that tag while decoding, and the re-encoded JPEG is upright — with the tag itself
    gone, because the metadata is gone.
  - **WebP carries its orientation in an `EXIF` chunk**, which the processor reads the same way, and
    which the store's own byte scan reads for the refusal rule below. Where the chunk is absent, no
    orientation is applied, and none is claimed.
  - **PNG has no EXIF orientation in this path.** A PNG *may* carry an `eXIf` chunk — the store's own
    scan reads one, which is what makes the refusal below apply to a PNG too — but no orientation is
    applied to a PNG by this processor, so a re-encoded PNG is **not** "turned upright by its EXIF
    orientation": there is none to apply. Saying otherwise would be false, and no such claim is made
    here.
- **An image passed through unchanged keeps whatever it carried**, and no stripping is claimed for
  it. To avoid storing location data while claiming it was removed, an image is **refused** when it
  was not re-encoded and its EXIF points at a GPS IFD or carries an orientation tag:

  > This image carries EXIF location data that cannot be removed without re-encoding it, so it was
  > not stored.

  In practice a camera photo large enough to exceed the maximum dimension is re-encoded and accepted;
  a small, upright photo carrying EXIF is refused rather than stored with its metadata intact.
- Annotation that is neither GPS nor orientation (a PNG `tEXt` chunk, a JPEG comment, WebP XMP)
  is not treated as a refusal on the pass-through path, and this document makes no claim that it is
  removed. Re-encoding removes all of it; passing through removes none of it.

Nothing here can re-encode an image without the processor. If the processor is ever unavailable, the
processor call fails and every upload is refused as undecodable — the store never falls back to
storing bytes it could not verify.

## The store: layout, immutability, caching

- One accepted image is one file: `<data root>/media/<sha256-of-the-stored-bytes>.bin`, written
  mode **0600** inside a **0700** `media` directory.
- The key is the content hash, so **identical bytes are one object**, and an object is created with
  `wx`: an existing path is never rewritten, whatever it holds.
- **A media id is never a path.** It must be 64 lowercase hex characters; the path is derived from it
  as `media/<id>.bin`, so there is no separator to inject. An id of any other shape is simply
  unknown (404).
- **The container itself is validated, never assumed.** `<data root>/media` must be a real directory
  this process can write, and an upload checks exactly that before it decodes or stores anything — so a
  broken data root is a named refusal, never a raw filesystem error the owner cannot act on. A `media`
  that is a **symbolic link** is never followed, a `media` that is **not a directory** is not read as
  an empty store, and a `media` that is **not writable by this process** is refused, each with its own
  reason. An upload against any of those is `503` with code `media-container` and stores nothing; a
  read of an object under such a container is a plain `404`, because a read goes through the
  contained-path helper below, which refuses a symlink at every component. A data root that has never
  stored an image has no `media` directory at all: the first accepted image creates it `0700`, as it
  always has. A backup treats the same container as fail-closed rather than capturing nothing
  ([Backup](BACKUP.md)).
- Reads go through the same contained-path helper as the rest of the application
  (`src/server/paths.ts`), which refuses absolute paths, `..` and **a symlink at any path
  component** — so neither a symlinked object nor a symlinked `media` directory is ever followed.
  The bytes are sniffed again on read, and bytes that are not a JPEG, PNG or WebP are not served.
- **Retention:** nothing is deleted automatically. An object lives as long as the data root; a
  refused upload writes nothing, and removing media is a deliberate operator action on the data root
  (there is no delete route).
- **The media directory is part of the full-state backup.** `media/` is captured by
  `scripts/data-tools.mjs` as `media/<sha256>.bin` entries in the archive manifest, so a stored image
  survives a backup and a restore ([Backup, restore and promotion](BACKUP.md)). A restore that did not
  carry it would silently lose every stored image.

## Serving

`GET /api/media/<id>` is behind the **same owner-only authentication and the same Host check as
every other route** — no media route is anonymous, and a wrong `Host` is `403` before anything
else. The response carries:

- `Content-Type` from the **sniffed** bytes, never from a declaration;
- `X-Content-Type-Options: nosniff`;
- `Cache-Control: private, max-age=31536000, immutable` — `private` because the response is
  owner-only, `immutable` because the id is a content hash and the object is never rewritten;
- `Content-Length`.

The composer fetches it with the session header and shows it as a blob URL, because an `<img src>`
request cannot carry that header.

## Vision: admission and dispatch both check

A stored image declares the capability it needs: `requires: ["image"]`. It is checked **server-side
twice**, against the model in play, using the model's own declared input modalities
(`Model.input` from the model catalog) — a client-side hint is not a check.

- **Admission.** The upload route reads the model the project's session has selected. If that model
  does not accept image input, the image is refused with `422` and code `vision` **before any bytes
  are stored**, and the reason names the model.
- **Dispatch.** Submitting a message that carries images re-checks the model that the submission will
  **actually run under** inside the harness, before anything is admitted. A model that cannot take
  images refuses the whole submission with `409`:

  > The model example / text-only-model does not accept image input, so the message was refused
  > rather than sent with the image removed.

  This catches the case admission cannot: an image stored while an image-capable model was selected,
  and a different model chosen before the send. An unknown model fails closed: it accepts nothing.
- **A refusal beats a silent drop.** An image is never removed from a message to make it sendable, and
  image bytes are never sent to a model that would ignore them. When the model accepts images, the
  stored bytes are attached to the input as an image content block alongside the text.
- **The model this check reads is the one the session is configured with.** Switching models while a
  run is in flight is refused (`409`, *"Stop the current run before changing models"*), so the model
  a submission is checked against cannot change under it.
- An image id that is not in the store is refused (`422`, code `unknown-media`) rather than dropped,
  and more than `MAX_IMAGES_PER_MESSAGE` ids in one message is refused (`422`, code
  `too-many-images`) with a reason that names the count, before any id is resolved.
- **A resume or a retry carries the images the original input carried.** The stored content blocks are
  read back, so a replayed dispatch submits the same image bytes and types; when they cannot be read
  back, the replay refuses with a clear reason instead of sending the text alone. A replay that
  carries images also runs the dispatch-time vision check above.

## The composer

`src/client/ImageComposer.svelte` owns the image half of the agent composer: a file picker (with the
`capture` attribute, so a phone offers its camera), paste, and drag and drop. Every path goes through
the same upload route. One gesture is handled exactly once — the composer area around the strip owns
the single paste and drop handler, the default is prevented once, and a file a gesture lists twice is
enqueued once — so one drop or paste yields one item and one upload. Each selected image shows a
bounded preview, its stored size and decoded dimensions, and any resize or re-encode note; a refusal
shows the server's own reason on that image. A preview that cannot be fetched is reported as its own
condition, never as a refusal, and it never removes an image the server has already accepted.
One image can be removed before sending, and a message needs text or at least one accepted image.

An upload in flight is not a stored image, so the composer **holds the message** until it is. While any
selected image is still uploading, Send and Steer are disabled, the state is named next to them, and a
send attempted anyway is refused with its own reason rather than sending the text without the image —
the strip is never cleared while an upload is outstanding. A message is never sent whose accepted image
has not been stored yet.
