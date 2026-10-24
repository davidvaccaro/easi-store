# Initial DICOMweb profile

EASI Store starts with the core archive transactions users expect. The target is eventual broad support for the released normative standard, implemented in explicit phases. The 0.1.0 preview is a **documented subset**, not a declaration of full PS3.18 or complete Studies Service conformance.

Reference baseline: [DICOM PS3.18, Web Services](https://dicom.nema.org/medical/dicom/current/output/chtml/part18/PS3.18.html), released 2026d when this implementation was started. A future release must pin/review its baseline rather than assume the `current` URL stays unchanged.

Base URL: `http://127.0.0.1:8048/dicomweb`.

## Transaction matrix

| Transaction/resource | Initial profile |
| --- | --- |
| QIDO studies | Supported: `GET /studies` |
| QIDO series within a study | Supported: `GET /studies/{study}/series` |
| QIDO instances within a series | Supported: `GET /studies/{study}/series/{series}/instances` |
| STOW binary DICOM | Supported: `POST /studies` and `POST /studies/{study}` with `multipart/related; type="application/dicom"` |
| WADO original instance | Supported: `GET /studies/{study}/series/{series}/instances/{instance}` |
| WADO original series/study | Supported as multipart original DICOM retrieval |
| Complete DICOM JSON metadata endpoint | Planned; QIDO returns selected indexed attributes only |
| XML metadata / metadata-plus-bulk STOW | Planned |
| Frame and bulk-data retrieval | Planned |
| Rendered resources, arbitrary transcoding | Planned |
| WADO-URI | Planned legacy compatibility |
| UPS/workitems/subscriptions and other advanced services | Later phases |

`GET /api/v1/capabilities` is the runtime authority for the server's implemented subset. Unsupported media types or requested representations must produce an explicit error; returning different bytes under a claimed requested transfer syntax is not acceptable.

## Authentication

Complete setup in the browser. The library uses same-origin authenticated sessions; connected clients must authenticate before accessing any archive resource, including original files. Do not enable wildcard cross-origin access to make a client work.

For a command-line session, read a login JSON object from standard input so your password does not become a shell-history argument:

```sh
umask 077
curl --fail-with-body --cookie-jar /tmp/easi-store.cookies \
  --header 'Content-Type: application/json' \
  --header 'X-EASI-Store: 1' \
  --data-binary @- http://127.0.0.1:8048/api/v1/login
```

Type `{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}`, then end input with Control-D (or the equivalent on your platform). That input is visible in the terminal; use a private terminal. Treat the resulting cookie file as a credential, restrict access to it, and delete it after testing. Subsequent examples use that cookie jar. Do not commit credentials or cookie files.

For a persistent integration credential, stop Store and run `node src/cli.js token --label 'My local client'` with the same `--data-dir` when using a custom archive. It prints a new token once; save it privately and restart Store. Clients send `Authorization: Bearer TOKEN`. Tokens are stored as hashes; this initial CLI workflow is for a local administrator with archive filesystem access. Token issuance does not replace the future granular service-identity/RBAC design.

Cookie-based mutations, including login and STOW, require **`X-EASI-Store: 1`** in addition to the authenticated cookie where applicable. This is part of the same-origin request protection. Bearer clients do not need that cookie-specific header.

## Search

```sh
curl --fail-with-body --cookie /tmp/easi-store.cookies \
  --header 'Accept: application/dicom+json' \
  'http://127.0.0.1:8048/dicomweb/studies'
```

Replace the placeholder UID components to enumerate a selected study:

```sh
curl --fail-with-body --cookie /tmp/easi-store.cookies \
  --header 'Accept: application/dicom+json' \
  'http://127.0.0.1:8048/dicomweb/studies/STUDY_UID/series'

curl --fail-with-body --cookie /tmp/easi-store.cookies \
  --header 'Accept: application/dicom+json' \
  'http://127.0.0.1:8048/dicomweb/studies/STUDY_UID/series/SERIES_UID/instances'
```

Results are DICOM JSON datasets containing indexed query attributes, not Store's management JSON records. The preview recognizes keyword or tag-number matching for PatientName, PatientID, StudyInstanceUID, StudyDate, StudyDescription, Modality, SeriesInstanceUID, and SOPInstanceUID. It supports simple `*`/`?` text matching, StudyDate ranges, UID lists, `limit` (1–1000; default 100), and `offset`. `includefield` is limited to indexed keys; `includefield=all` is rejected. Unknown matching fields are rejected rather than silently ignored. Do not assume every optional QIDO key, fuzzy matching, timezone matching, or arbitrary return key is supported. An empty successful query returns an empty JSON array.

## Store an original instance

STOW uses MIME parts, not HTML `multipart/form-data`. This Node 24 example streams a local instance without concatenating its pixel data into a second in-memory copy. Authenticate through the browser/command-line flow and supply its cookie value privately through `EASI_STORE_COOKIE`; never put a real token in source control.

```js
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const boundary = `easi-${randomUUID()}`;
if (!process.env.EASI_STORE_COOKIE) throw new Error('Supply your authenticated session cookie privately.');
async function* body() {
  yield `--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`;
  yield* createReadStream('/absolute/path/to/instance');
  yield `\r\n--${boundary}--\r\n`;
}
const response = await fetch('http://127.0.0.1:8048/dicomweb/studies', {
  method: 'POST',
  headers: {
    'Content-Type': `multipart/related; type="application/dicom"; boundary="${boundary}"`,
    Accept: 'application/dicom+json',
    Cookie: process.env.EASI_STORE_COOKIE,
    'X-EASI-Store': '1',
  },
  body: Readable.from(body()),
  duplex: 'half',
});
console.log(response.status, await response.text());
```

The selected file may have any extension, including none. It must be a DICOM Part 10 instance in this profile; bare datasets without file meta information are not accepted by HTTP ingestion. Unsupported text encodings, including unsupported ISO 2022 escape-based character sets, are rejected explicitly (422) rather than indexed as corrupted text.

A response is not a promise to persist later: successful instance outcomes follow durable ingest. Identical bytes are idempotent; an already stored SOP Instance UID with conflicting bytes is not overwritten. Read the instance-specific STOW result, including failures; a multipart request does not make a whole study one atomic operation. HTTP 202 in STOW describes mixed outcomes and must not be interpreted as a generic background-job acknowledgment. If the outer MIME envelope becomes malformed after earlier parts have committed, the request can return 400 while those earlier originals remain stored. Retry the corrected request; identical instances remain idempotent.

## Retrieve original bytes

```sh
curl --fail-with-body --cookie /tmp/easi-store.cookies \
  --header 'Accept: multipart/related; type="application/dicom"; transfer-syntax=*' \
  'http://127.0.0.1:8048/dicomweb/studies/STUDY_UID/series/SERIES_UID/instances/INSTANCE_UID' \
  --output instance.multipart
```

The response includes MIME framing. Use a DICOMweb-aware client to extract the DICOM part, or use the library's **Download original** action for a direct `application/dicom` attachment. An archived instance's original transfer syntax is preserved. This preview has no implicit guarantee of conversion to Explicit VR Little Endian or another requested syntax.

## Release criteria

Each expansion needs a conformance matrix recording transaction, resource, request/response media types, transfer syntaxes, status behavior, and error cases. Tests must include independent clients, mixed STOW outcomes, restart persistence, duplicate/conflict handling, malformed multipart boundaries, unauthorized access to every resource, and retrieval byte hashes.

An EASI Store management deletion route, if added, is not a standard DICOMweb DELETE operation. Likewise, complete object storage support must not be confused with the viewer's supported rendering profiles.
