# DICOMweb implemented profile — 1.0.0-rc.1

EASI Store implements the core archive transactions plus bounded metadata and pixel retrieval. The target is eventual broad support for the released normative standard, implemented in explicit phases. The current release-candidate profile is a **documented subset**, not a declaration of full PS3.18 or complete Studies Service conformance.

Reference baseline: [DICOM PS3.18, Web Services](https://dicom.nema.org/medical/dicom/current/output/chtml/part18/PS3.18.html), released 2026d when this implementation was started. A future release must pin/review its baseline rather than assume the `current` URL stays unchanged.

Base URL: `http://127.0.0.1:8048/dicomweb`.

## Transaction matrix

| Transaction/resource | Implemented first-release profile |
| --- | --- |
| QIDO studies | Supported: `GET /studies` |
| QIDO series within a study | Supported: `GET /studies/{study}/series` |
| QIDO instances within a series | Supported: `GET /studies/{study}/series/{series}/instances` |
| STOW binary DICOM | Supported: `POST /studies` and `POST /studies/{study}` with `multipart/related; type="application/dicom"` |
| WADO original instance | Supported: `GET /studies/{study}/series/{series}/instances/{instance}` |
| WADO original series/study | Supported as multipart original DICOM retrieval |
| DICOM JSON dataset metadata | Supported: study, series, and instance `/metadata`; nested sequences and functional groups retained within the bounded metadata profile |
| XML metadata / metadata-plus-bulk STOW | Planned |
| Selected frames | Supported: instance `/frames/{1-based-frame-list}`; native little-endian output or supported original compressed encoding |
| Referenced bulk values | Supported: `BulkDataURI` values returned by metadata, including nested attribute paths; access follows the selected client profile |
| Rendered resources, arbitrary transcoding | Planned |
| WADO-URI | Planned legacy compatibility |
| UPS/workitems/subscriptions and other advanced services | Later phases |

`GET /api/v1/capabilities` is the runtime authority for the server's implemented subset. Unsupported media types or requested representations must produce an explicit error; returning different bytes under a claimed requested transfer syntax is not acceptable.

## Client access

Store has two explicit client profiles, configured in **Administration → Client access** or through `--access-profile` at startup. The [access guide](ACCESS_CONTROL.md) describes persistence, configuration, and deployment boundaries.

- **Authenticated** is the default. Every DICOMweb resource, including metadata, frames, bulk values, originals, STOW, and `OPTIONS`, requires a role-authorized Store API Bearer credential or local/OIDC session cookie. Reader permits query/retrieve; STOW requires contributor or administrator rights. Machine clients do not need an interactive browser sign-in.
- **Local research** permits ordinary clients on actual loopback connections to use those DICOMweb transactions without credentials. Both HTTP and DIMSE listeners must bind to literal loopback addresses. Start with `node src/cli.js start --access-profile local-research`, or save the profile in Administration. The administrator interface and management API still require authentication.

`GET /api/v1/access` reports minimal access requirements without returning patient information or peer configuration. A forwarded IP header cannot grant research access. Do not enable wildcard cross-origin access or publicly forward an unauthenticated research listener.

The following authenticated examples use a cookie jar. In local research mode, omit the cookie option; normal non-browser STOW clients also do not need the custom `X-EASI-Store` header. Host validation and rejection of foreign browser-origin writes remain active in both profiles.

For a command-line session, read a login JSON object from standard input so your password does not become a shell-history argument:

```sh
umask 077
curl --fail-with-body --cookie-jar /tmp/easi-store.cookies \
  --header 'Content-Type: application/json' \
  --header 'X-EASI-Store: 1' \
  --data-binary @- http://127.0.0.1:8048/api/v1/login
```

Type `{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}`, then end input with Control-D (or the equivalent on your platform). That input is visible in the terminal; use a private terminal. Treat the resulting cookie file as a credential, restrict access to it, and delete it after testing. Subsequent examples use that cookie jar. Do not commit credentials or cookie files.

For a persistent integration credential, use **Administration → Identity** while Store is running. An administrator chooses a named, expiring `reader` credential for query/retrieve or a `contributor` credential for STOW/import. The creation API returns `{token,credential}` once; retain only the secret in the client's protected configuration and send `Authorization: Bearer TOKEN`. Lists omit secrets/hashes, and administrators can revoke credentials online. The offline `token` CLI remains an operator compatibility path. See [identity and permissions](IDENTITY.md) for the exact lifecycle and archive-wide role limits.

In authenticated mode, cookie-based mutations, including login and STOW, require **`X-EASI-Store: 1`** in addition to the authenticated cookie where applicable. This is part of the same-origin request protection. Bearer clients do not need that cookie-specific header. Management/login mutations keep their normal protections in local research mode too.

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

Phase 2 also matches `IssuerOfPatientID`, `PatientBirthDate`, `AccessionNumber`, `ModalitiesInStudy`, `SeriesDescription`, `SeriesNumber`, and `InstanceNumber`. Birth/study dates accept ranges. `ModalitiesInStudy` matches modalities present anywhere in the study. `includefield` accepts repeated parameters or comma-separated indexed keywords/tag numbers; it augments the default returned attributes. Results use stable archive ordering and a `Warning` header when additional results are available. The supported QIDO hierarchy is studies → series in a study → instances in a series; do not assume flat all-series/all-instance searches are implemented.

Direct queries retain DICOM matching semantics: `PatientName=Synthetic` is a whole-value match, while `PatientName=Synthetic*` matches names beginning with that text. The standalone EASI View search workflow adds a trailing wildcard to a plain surname for convenience; explicit `*`, `?`, `^`, or `=` name syntax is preserved. Patient IDs and selected-patient issuer criteria remain exact. Store does not silently broaden a direct client's query.

## Store an original instance

STOW uses MIME parts, not HTML `multipart/form-data`. This Node 24 example streams a local instance without concatenating its pixel data into a second in-memory copy. Authenticate through the browser/command-line flow and supply its cookie value privately through `EASI_STORE_COOKIE`; never put a real token in source control.

Multipart boundaries normally follow RFC 2046's 70-character limit. The
independently tested Orthanc DICOMweb 1.19 client emits a 73-character delimiter
formed by the same canonical UUID twice, separated by a hyphen. Store accepts
only that fixed-size compatibility exception; arbitrary overlong boundaries,
different UUID pairs, control characters and existing request/header/part limits
remain rejected. This peer accommodation is not a broader MIME conformance claim.

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

## Retrieve metadata, frames, and bulk values

Metadata endpoints return `application/dicom+json` arrays for these scopes:

```text
GET /studies/{study}/metadata
GET /studies/{study}/series/{series}/metadata
GET /studies/{study}/series/{series}/instances/{instance}/metadata
```

The EASI JS streaming handler extracts dataset attributes, including nested SQ items, enhanced-image functional groups, numeric VR values, and declared supported character sets. This is separate from the small indexed QIDO return set. File Meta Information is not included in dataset JSON. Binary values and large individual values become `BulkDataURI` references governed by the same client access profile, rather than being decoded or embedded as large JSON values. Existing originals are read on demand; an archive created by 0.1.0 does not need reimporting.

Metadata is bounded to 8 MiB per instance and per response, 100,000 attributes, and sequence depth 64. A metadata response may cover at most 10,000 instances and four metadata responses/readers run concurrently. Larger studies should request individual series or instances. Unsupported encodings, malformed numeric values, or unreadable structures return explicit errors rather than silently incomplete metadata.

Selected frame example:

```sh
curl --fail-with-body --cookie /tmp/easi-store.cookies \
  --header 'Accept: multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1' \
  'http://127.0.0.1:8048/dicomweb/studies/STUDY_UID/series/SERIES_UID/instances/INSTANCE_UID/frames/1,2' \
  --output frames.multipart
```

Frame numbers are 1-based; duplicate/out-of-range values are rejected and a request contains at most 1,000 frames. Native data supports 1/8/16/32/64-bit geometry with a 64 MiB per-frame limit. Implicit VR Little Endian and Explicit VR Big Endian native inputs are normalized to little-endian pixel output; this does not transcode the original instance or change its attributes. One-bit frame boundaries are repacked correctly. Native selected frames are concatenated into one octet-stream MIME part.

Original compressed frame retrieval recognizes JPEG, JPEG-LS, JPEG 2000, JPEG 2000 Part 2, HTJ2K, and DICOM RLE transfer syntaxes when frame boundaries are unambiguous. It returns their matching MIME type and original syntax; it does not decode or recompress them. A valid Basic Offset Table is supported. An empty table is supported for a single frame or one fragment per frame; ambiguous multi-fragment/multiframe data is explicitly rejected. Extended-offset-only indexing and video/container formats are not implemented. Fragment count is limited to 100,000 and each encoded frame to 64 MiB. Archival acceptance, original retrieval, selected frame retrieval, and viewer rendering are separate capabilities.

Follow a returned `BulkDataURI` using the selected profile's credentials when required, rather than constructing arbitrary filesystem paths. Nested bulk references use validated attribute/item paths. Native bulk output uses little-endian numeric words where conversion is required; compressed pixel bulk follows the original frame profile and is limited to 1,000 frames in a whole-pixel-bulk request. For larger multiframe images, request selected frames instead. Bulk and frames follow the same access policy as other DICOMweb resources; no wildcard CORS policy is enabled. A request for an unsupported media type or transfer syntax returns `406`; malformed data or resource limits return their explicit error status.

`OPTIONS /dicomweb` (or a DICOMweb resource) returns the implementation's JSON capabilities and allowed methods. This describes the preview and does not declare full normative service conformance. Management thumbnail PNGs are documented in [MANAGEMENT_API.md](MANAGEMENT_API.md), not claimed as standard DICOMweb rendered resources.

## Release criteria

Each expansion needs a conformance matrix recording transaction, resource, request/response media types, transfer syntaxes, status behavior, and error cases. Tests must include independent clients, mixed STOW outcomes, restart persistence, duplicate/conflict handling, malformed multipart boundaries, unauthorized access to every resource, and retrieval byte hashes.

An EASI Store management deletion route, if added, is not a standard DICOMweb DELETE operation. Likewise, complete object storage support must not be confused with the viewer's supported rendering profiles.
