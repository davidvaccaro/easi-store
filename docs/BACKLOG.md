# Target implementation backlog

EASI Store's long-term target is a modern, approachable, independently implemented DICOM archive with broad standards support and straightforward deployment. “Replace Orthanc” is a product goal, not a claim made by the first preview. No Orthanc source or storage internals are required by this design.

## Phase 1 — working local foundation

**Initial slice:** independent project, Node 24 + EASI JS streaming indexing, SQLite/filesystem archive, durable imports and restart recovery, explicit duplicate/conflict handling, authenticated local setup, study/series/instance library, embedded EASI View, synthetic demo, core DICOMweb transaction subset, local Verification/Storage SCP, Docker, source launchers, and portable packaging.

Release gates:

- Original-byte hash round trips, rejection of malformed/oversized input, duplicate/conflict cases, durable import outcomes, interrupted-ingest recovery, and single-writer protection.
- Authentication enforced for all archive paths; first-run setup has no shared/default credentials.
- Library/UI smoke tests and independent DICOMweb client checks using synthetic data.
- A package can be extracted and run from a clean path; data stays outside the application tree.
- Report implemented profile and every unsupported representation honestly.

The source, tests, and runtime capabilities determine what has actually shipped; this list is not a blanket completion certificate.

## Phase 2 — everyday PACS interoperability

**Implemented in the 0.2.0 preview, within the published profiles:**

- DIMSE Verification/Storage receiving and outgoing SCU workflows, preserving encoded datasets and acknowledging receiving only after durable commit.
- Study Root / Patient Root C-FIND, C-GET, and configured-destination C-MOVE SCPs, Storage role negotiation, cancellation, pending/final/sub-operation statuses, and failure lists. Configured transfer jobs use hierarchical Study Root enumeration and durable C-GET SCU; remote C-MOVE initiation remains future work.
- Expanded QIDO indexed matching/return keys, comma/repeated `includefield`, pagination and stable ordering.
- Nested JSON dataset metadata and protected referenced values; supported native/original-compressed frame retrieval with explicit resource/fragment limits.
- Native little-endian frame/word conversion. Whole-instance conversion and compressed transcoding remain unimplemented; stored representations remain preserved.
- Bounded instance/series management thumbnails and independent EASI View connection integration. Embedded whole-series loading remains limited to its current 128 MiB / 2,000-frame profile; this is not unlimited study buffering.
- Named DICOMweb/DIMSE peers, real connection tests, remote search, and persistent queued sends/retrievals with instance checkpoints, restart, manual retry, cancellation, and destination revision guards.

**Continuing interoperability work:** broader independent clients/modalities and negotiated syntax coverage, remote C-MOVE initiation, optional/relational query profiles, better job scheduling/retention and timed retries, larger-study viewer workflow qualification, DICOM TLS, and production network identity. Follow [STATUS.md](STATUS.md), [DICOMWEB.md](DICOMWEB.md), [DIMSE.md](DIMSE.md), and candidate-specific [VALIDATION.md](VALIDATION.md).

EASI JS's existing DIMSE client/receiver support does not automatically provide a production Store SCP. A receiver that acknowledges before persistence must not be used unchanged as a durable archive listener.

## Phase 3 — research and data management

- Collections and labels that reference archived instances without duplicating them.
- Safe import from folders/media/DICOMDIR and resumable bulk import manifests.
- Exports with DICOMDIR/ZIP where appropriate; integrity reports and deterministic selection.
- Anonymization profiles based on PS3.15 Annex E, UID/reference consistency, dates, private attributes, and provenance. Burned-in text, documents, graphics, and pixel content need explicit handling; deleting a few tags is not complete anonymization.
- Conflict/alternate-representation review, protected studies, quotas, retention, and auditable destructive actions.
- Routing rules and subscriptions/webhooks with durable retry semantics.
- Orthanc migration through documented API/protocol export, resumable manifests, counts and original-byte verification. Never reinterpret or edit a live Orthanc database/blob directory.

## Phase 4 — broader normative DICOMweb

Maintain a versioned conformance matrix against the released normative baseline. Prioritize primary Studies Service completeness before advanced families:

- XML metadata and JSON/XML metadata-plus-bulk STOW representations; JSON metadata is implemented in Phase 2 within bounded limits.
- Rendered resources, content negotiation, transfer syntaxes, frame/bulk behavior, cache/range/error semantics where applicable.
- Extended query behavior and explicit machine-readable service capabilities.
- Workitems/UPS and subscriptions; non-patient objects; web storage commitment; scheduled procedure steps/worklist and performed procedure-step services as defined by the adopted edition.
- Independent interoperability/event testing and a published conformance statement per release.

Do not equate “QIDO + WADO + STOW routes exist” with implementing the entire standard. There is no standard DICOMweb DELETE transaction; management APIs stay distinct.

## Phase 5 — managed infrastructure and deployment

- PostgreSQL catalog and S3-compatible object storage adapters with shared durability/reconciliation contracts.
- Concurrency, deployment/upgrade migrations, backup/snapshot/restore tooling, disaster recovery, capacity planning, and integrity scrubbing.
- OIDC, granular RBAC, service identities, complete audit policy, secure HTTPS/proxy configuration, DICOM TLS, key rotation, and operational diagnostics.
- Native macOS signed/notarized installer; Windows signed installer; Linux desktop packages and service units. Upgrade/uninstall must preserve archive data and make data-removal a separate explicit action.
- Published AMD64/ARM64 images, software bill of materials, dependency/image scans, signed artifacts/provenance, and repeatable release verification.
- Benchmarked single-host and production deployments; measure performance before introducing another implementation language.

## Stable 1.0 gate

A stable version requires a declared supported profile, independent interoperability evidence, reproducible clean installation, a proven backup/restore path, bounded-resource behavior, upgrade/recovery tests, clear user workflows, complete license/notices, and an explicit operational support statement. AI, cloud lock-in, a marketplace, and an unqualified language port are not prerequisites.
