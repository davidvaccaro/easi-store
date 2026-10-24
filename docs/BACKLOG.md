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

- Broader DIMSE Verification/Storage interoperability and outgoing SCU workflows, retaining success acknowledgment only after durable commit.
- Query/Retrieve roles: C-FIND, C-MOVE, C-GET; explicit Patient/Study Root profiles, move destination configuration, peer diagnostics, cancellation, and network/TLS limits.
- QIDO matching/return keys, pagination, consistent ordering, meaningful connection diagnostics, and broader client interoperability.
- Complete metadata services and frames/bulk-data retrieval before relying on them in viewer integration.
- Support required/default transfer syntaxes and negotiated conversion deliberately; preserve original representations and provenance.
- Instance/series thumbnails and lazy series viewing; large studies remain responsive and bounded.
- Endpoint/source management and connection testing; durable queued operations with restart/retry/cancellation behavior.

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

- JSON/XML metadata and metadata-plus-bulk STOW representations.
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
