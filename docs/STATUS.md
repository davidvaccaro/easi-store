# EASI Store status — 0.2.0

**Phase 2 interoperability preview.** EASI Store is a working, independent, single-host archive. It is source available under the Community License; it is not a claim of full DICOM conformance, Orthanc parity, or production/clinical qualification.

| Area | Implemented |
| --- | --- |
| Archive | Bounded disk-backed imports, SHA-256 integrity, explicit duplicate/conflict outcomes, crash recovery, SQLite single-writer protection, offline backup/restore |
| Library | Patient/study/series/instance browsing, search, lazy management thumbnails, published independent EASI View SDK |
| DICOMweb | Indexed QIDO hierarchy; binary Part 10 STOW; original WADO; nested JSON metadata; supported native/original-compressed frame and referenced-bulk retrieval |
| DIMSE server | Verification / Storage, Study Root and Patient Root FIND / GET / configured-destination MOVE, pending/final statuses, cancellation, durable receiving |
| Connected archives | Named DICOMweb/DIMSE peers, connection tests, remote study searches, explicit send/retrieve workflows |
| Transfers | Streamed STOW/C-STORE sends and WADO/durable C-GET retrievals; persistent per-instance checkpoints, restart, retry, cancellation |
| Security | Local administrator, HTTP-only sessions, Bearer integrations, protected archive resources, same-origin mutation checks, fixed configured destinations, server-held remote credentials |
| Deployment | Docker, source launchers, portable runtime packaging; platform-signed installers remain planned |

See [DICOMWEB.md](DICOMWEB.md) and [DIMSE.md](DIMSE.md) for exact profiles. A supported service name does not mean every optional representation, SOP class behavior, matching rule, or deployment topology is supported. `GET /api/v1/capabilities` and authenticated DICOMweb `OPTIONS` report the running build; the optional DIMSE listener can be disabled.

HTTP/file imports preserve their original Part 10 bytes. DIMSE transmits datasets rather than Part 10 file metadata; Store preserves the transmitted dataset and generates the receiving file's meta header. Reintroducing the same SOP Instance UID in a different Part 10 representation can therefore be an explicit byte conflict even when its image pixels are equivalent.

## Next work

The next product milestone is Phase 3: collections/labels, research import/export, controlled anonymization, routing, and migration. Protocol qualification and standards expansion continue alongside that work. Whole-instance transcoding, XML metadata/STOW, standard rendered resources, WADO-URI, UPS/workitems, worklists, MPPS, Storage Commitment, DICOM TLS, PostgreSQL/S3, OIDC/RBAC, automatic routing, and signed installers remain planned.

Stable 1.0 still requires the release gates in [BACKLOG.md](BACKLOG.md), including qualification of the exact candidate. Historical 0.1.0 platform results do not certify a changed 0.2.0 artifact. [VALIDATION.md](VALIDATION.md) separates baseline evidence from Phase 2 checks.
