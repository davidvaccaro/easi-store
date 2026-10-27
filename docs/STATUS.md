# EASI Store status — 0.5.0

**V1 workflow preview.** EASI Store is a working, independent, single-host archive. It is source available under the Community License; it is not a claim of full DICOM conformance, Orthanc parity, or production/clinical qualification.

| Area | Implemented |
| --- | --- |
| Archive | Bounded disk-backed imports, SHA-256 integrity, explicit duplicate/conflict outcomes, crash recovery, SQLite single-writer protection, offline backup/restore |
| Library | Patient/study/series/instance browsing, search, lazy management thumbnails, metadata-first/on-demand series viewing through the published EASI View SDK |
| Research datasets | Saved cross-study series selections, organizational labels/review notes, indexed technical checks, immutable version/hash manifests, explicit subject-grouped splits, availability checks, metadata-only removal, synthetic cohort |
| Training data access | Authenticated bounded Python downloader with integrity/resume/reporting; optional pinned MONAI native 2D/multiframe CPU loading example |
| Study management | Streamed ZIP/ZIP64 original export with SHA-256 manifest; preview/revision/typed confirmation for removal, auditable counts and interrupted-removal recovery |
| DICOMweb | Indexed QIDO hierarchy; binary Part 10 STOW; original WADO; nested JSON metadata; supported native/original-compressed frame and referenced-bulk retrieval |
| DIMSE server | Verification / Storage, Study Root and Patient Root FIND / GET / configured-destination MOVE, pending/final statuses, cancellation, durable receiving |
| Connected archives | Named DICOMweb/DIMSE peers, connection tests, remote study searches, explicit send/retrieve workflows |
| Transfers | Streamed STOW/C-STORE sends and WADO/durable C-GET and correlated C-MOVE retrievals; persistent per-instance checkpoints, restart, retry, cancellation |
| Client access | Explicit authenticated or loopback-only local research DICOMweb profiles; administration remains authenticated; persisted AE/source-IP DIMSE trust and separate listener binding |
| Security | Local administrator, HTTP-only sessions, Bearer integrations, host/origin mutation checks, fixed configured destinations, server-held remote credentials |
| Deployment | Docker, source launchers, portable runtime packaging; platform-signed installers remain planned |

See [DICOMWEB.md](DICOMWEB.md), [DIMSE.md](DIMSE.md), and [ACCESS_CONTROL.md](ACCESS_CONTROL.md) for exact profiles. A supported service name does not mean every optional representation, SOP class behavior, matching rule, or deployment topology is supported. `GET /api/v1/capabilities` requires management authentication; DICOMweb `OPTIONS` follows the selected client access profile. Both report the running build. The optional DIMSE listener can be disabled.

New and existing archives default to authenticated DICOMweb access. A client can use an API Bearer token without an interactive browser session. For an archive on one workstation, an administrator can explicitly choose **Administration → Client access → Local research**; local DICOMweb clients then need no credentials. Both listeners must remain on literal loopback addresses. DIMSE has independent AE/IP trust rules, not HTTP user authentication. Neither profile supplies DICOM TLS, granular roles, or production qualification.

HTTP/file imports preserve their original Part 10 bytes. DIMSE transmits datasets rather than Part 10 file metadata; Store preserves the transmitted dataset and generates the receiving file's meta header. Reintroducing the same SOP Instance UID in a different Part 10 representation can therefore be an explicit byte conflict even when its image pixels are equivalent.

## Next work

The 0.5.0 milestone implements the [AI dataset workflow](AI_DATASETS.md): a saved selection, immutable exact-membership versions, optional subject-grouped splits, technical inventory, verified Python downloads and a narrow qualified MONAI loading example. It includes the minimum research-facing labels/bulk selection/programmatic access from Phase 3. General tag correction, in-house anonymization, routing and broad migration remain demand-led.

V1 preparation now focuses on exact-candidate qualification, reproducible installation, backup/restore and operational guidance for this single-host research profile. Dataset metadata shares catalog schema 2; original objects are not rewritten. Take a full pre-upgrade backup and restore that backup for rollback instead of opening new state with an older runtime. Full-standard expansion continues separately; PostgreSQL/S3, external identity/RBAC, DICOM TLS, worklists and signed installers remain planned.

Stable 1.0 still requires the release gates in [BACKLOG.md](BACKLOG.md), including qualification of the exact candidate. Historical 0.1.0–0.2.1 results do not certify a changed 0.5.0 artifact. [VALIDATION.md](VALIDATION.md) separates baseline evidence from checks of the current candidate.
