# Architecture

EASI Store is a modular monolith: one Node.js 24 service serves the management UI, authenticated APIs, DICOMweb, and local archive. EASI JS parses streaming DICOM input. EASI View renders supported images in the browser through its public SDK. These remain independent packages and assets.

The same process includes local DIMSE Verification/Storage and Study/Patient Root Query/Retrieve services. Its C-STORE acknowledgment follows the same durable ingest path as HTTP, including incoming C-GET storage sub-operations. It listens on AE `EASISTORE`, port 4248 by default. C-MOVE resolves destinations through explicit configured peers; DICOM TLS is not implemented in this preview.

```mermaid
flowchart LR
  Browser[Study library and EASI View] --> HTTP[Authenticated HTTP service]
  Clients[DICOMweb clients] --> HTTP
  HTTP --> Ingest[Bounded ingest and EASI JS metadata selection]
  Ingest --> Objects[Original objects on local filesystem]
  Ingest --> Catalog[SQLite catalog and activity]
  HTTP --> Catalog
  HTTP --> Objects
  DIMSE[DIMSE Verification / Storage / Query Retrieve] --> Ingest
  DIMSE --> Catalog
  Jobs[Persistent configured-peer transfer queue] --> Ingest
  Jobs --> Objects
  Jobs --> Peers[DICOMweb / DIMSE peers]
  HTTP --> Jobs
```

## Data boundary

The importer streams an instance into a bounded staging file, hashes the original bytes, and extracts selected indexing attributes without decoding pixel data. An accepted original is stored under an opaque path. Catalog commit and success response follow durable object persistence. A journal/reconciliation step handles interruptions across the filesystem/database boundary; those two resources do not share a transaction.

Identical SOP Instance UID and identical bytes is an idempotent duplicate. A different representation under an already stored SOP Instance UID is an explicit conflict in this first profile. The preview does not guess which representation should replace another. Future representation management must retain provenance and define safe normalization rules.

The hierarchy is patient → study → series → instance. Patient identity is scoped; it is not derived from a display name alone. Study/series/SOP UIDs remain protocol identifiers; storage paths do not use patient names or medical record numbers. The relational catalog stores indexed DICOM attributes and import outcomes, not pixel payloads.

DIMSE carries datasets without a Part 10 wrapper. Store creates File Meta Information while retaining the encoded dataset. This is distinct from an HTTP original import, whose entire Part 10 bytes are preserved. The conflict policy deliberately does not equate two different files merely because their pixels or UIDs match.

## Metadata, thumbnails, and transfer boundaries

Full nested dataset JSON is derived on demand from existing originals through EASI JS's streaming handler seam. Binary and large values remain bounded file-range descriptors/BulkDataURI references. This avoids a destructive reindex/reimport migration and avoids pixel decoding for the catalog. Metadata extraction/response concurrency, attributes, sequence depth, cache size, and frame/fragment counts are independently bounded. Native frame conversion produces little-endian pixel values; original instance retrieval remains unchanged.

Thumbnail rendering is a separate, limited management feature. Two bounded workers generate small PNGs for supported native and baseline-JPEG profiles; unsupported objects keep a fallback icon. Thumbnails neither establish display support for every archived object nor imply a standard DICOMweb rendered-resource implementation. The embedded viewer uses the independently published SDK's archive interface: metadata first, then individual originals on demand. It no longer materializes every encoded instance in a series before opening. Per-object, metadata, decoded-cache, and stack limits remain enforced by the SDK; this is not unlimited memory or universal image support.

Configured peers and `transfer_jobs`/`transfer_items` live in the archive SQLite catalog. One instance transfers at a time, with its UID-only selection snapshotted and an acknowledgment checkpoint committed before continuing. A destination revision guards retries after configuration changes. A crash between remote acceptance and local checkpoint can cause duplicate delivery; this is not a distributed exactly-once transaction. Restart resumes unfinished work, while explicit cancellation intent is retained. Server credentials are resolved by a private configured name and never serialized into browser connection records.

## Interfaces

| Interface | Purpose |
| --- | --- |
| `/` | First-run setup, sign-in, library, and embedded viewer |
| `/api/health` | Minimal public service health |
| `/api/v1/session` | Minimal authentication/setup state |
| `/api/v1/setup`, `/login`, `/logout` | Local administration/session lifecycle |
| `/api/v1/summary` | Archive counts and stored bytes |
| `/api/v1/studies` | Management study search |
| `/api/v1/studies/{study}/series` | Series summaries |
| `/api/v1/studies/{study}/series/{series}/instances` | Instance summaries |
| `/api/v1/instances` | Raw `application/dicom` management import |
| `/api/v1/demo` | Generated synthetic demo import |
| `/api/v1/activity` | Persisted import/removal outcomes |
| `/api/v1/studies/{study}/export` | Streamed original ZIP with SHA-256 manifest |
| `/api/v1/studies/{study}/deletion-preview` | Current count/byte/revision preview |
| `DELETE /api/v1/studies/{study}` | Confirmed archival-copy removal and storage reclamation |
| `/api/v1/connections` | Explicit remote peer configuration, diagnostics, and study search |
| `/api/v1/jobs` | Durable transfer jobs and progress/cancel/retry |
| `/api/v1/studies/{study}/series/{series}/thumbnail` | Authenticated management PNG preview |
| `/api/v1/capabilities` | Implemented protocol/profile capabilities |
| `/api/v1/download/{study}/{series}/{instance}` | Original DICOM download |
| `/dicomweb` | Indexed query, original storage/retrieval, nested JSON metadata, supported frames/bulk; see DICOMweb guide |

Management archive resources always require authorization. DICOMweb follows the explicit authenticated or loopback-only local-research profile; minimal health/session endpoints expose no catalog or patient information. The browser uses same-origin sessions. The management API does not imply compatibility with Orthanc's REST API.

## Export and removal durability

Export snapshots minimal immutable original records under a read lease. A bounded ZIP writer lazily opens one original per export, honors HTTP backpressure, and verifies original bytes against catalog SHA-256 and size while streaming. The manifest follows verified originals; integrity failure aborts the download. No study-sized browser Blob or server memory buffer is needed. ZIP/ZIP64 generation uses MIT-licensed yazl and buffer-crc32.

Removal reserves an archive mutation gate before yielding. Active import/read leases and target queued/running/canceling transfers block it; new imports/readers/job creation cannot enter the deletion boundary. HTTP WADO/bulk/frame/thumbnail/original downloads, exports, outgoing jobs, and native DIMSE retrieval hold leases through their file reads. This initial gate is archive-wide and conservative.

A synchronized intent journal records the preview snapshot. Schema 2 adds a committed deletion marker: SQLite removes catalog rows and writes that marker plus activity counts in the same transaction. Original objects are then reclaimed only after confirming no remaining catalog references and verifying bytes/hash. Startup distinguishes uncommitted intent (keep the study) from committed deletion (finish reclamation), refusing corrupt or conflicting journals rather than resurrecting data. Reclamation failure after commit returns `202` with `reclamationPending:true` and blocks further archive data work pending restart/recovery.

Schema 1→2 migration preserves original objects and activity rows. Older runtimes refuse schema 2. Take a verified offline backup with the prior runtime before upgrading; rollback restores it into a separate directory. See [STUDY_MANAGEMENT.md](STUDY_MANAGEMENT.md).

## Storage evolution

The first adapter is SQLite plus a local filesystem, suited to a single-host archive with a single writer. Do not put a live SQLite WAL database on a network filesystem or share a data directory between containers. [SQLite's WAL documentation](https://www.sqlite.org/wal.html) explains that WAL requires a single host.

PostgreSQL and S3-compatible object storage are separate planned adapters. Introducing them requires object/catalog recovery, concurrent writers, integrity verification, migrations, and backup/restore qualification; swapping a connection string alone would not establish production readiness.

## Performance principles

- Bound encoded input and temporary storage; stream toward disk rather than buffering a study in RAM.
- Index metadata without pixel decode. Archive storage must not depend on the viewer's rendering support.
- Apply backpressure and define cancellation/shutdown behavior before introducing concurrency.
- Keep CPU-heavy transformations behind worker boundaries; thumbnail rendering already uses bounded workers.
- Benchmark parser throughput, fsync cost, catalog updates, time to first image, and memory on realistic workloads before considering a language port.

The initial implementation deliberately reuses EASI JS. A future native component should solve a demonstrated bottleneck while preserving the storage and protocol contracts.
