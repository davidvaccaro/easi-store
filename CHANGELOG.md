# Changelog

## 0.2.0 — Phase 2 interoperability preview

- Add Study Root and Patient Root DIMSE C-FIND, C-GET, and configured-destination C-MOVE SCPs, with pending/final/sub-operation statuses and cancellation.
- Add streamed outbound C-STORE and durable incoming C-GET adapters; receiving success follows object/catalog persistence.
- Add configured DICOMweb/DIMSE peers, diagnostic connection tests, remote study search, and send/retrieve workflows.
- Persist transfer jobs and instance checkpoints in the archive catalog; resume interrupted jobs, retry unfinished objects, cancel in-flight work, and guard changed destinations.
- Add nested DICOM JSON metadata and protected binary/large-value references without materializing image pixels for indexing.
- Add selected native frames with little-endian conversion and original compressed frames with supported unambiguous fragment boundaries.
- Expand QIDO matching and indexed return fields, including comma-separated/repeated `includefield` values.
- Add bounded thumbnail workers and lazy series/instance previews through management APIs.
- Document private named remote credentials and independent EASI View connection boundaries.

No original archive reimport is required: metadata is derived from existing stored objects. Back up the complete archive before upgrading. Remote transfers are explicit copies, and DIMSE receiving creates Part 10 metadata around the original transmitted dataset. This remains a preview; no full-standard or production qualification is implied.

## 0.1.0 — Foundation preview

- Establish the independent server, React management UI, EASI JS parsing, and published EASI View SDK integration.
- Add SQLite/filesystem durable intake, hashing, duplicate/conflict policy, recovery, authentication, and offline backups.
- Implement initial QIDO/STOW/original-WADO transactions, DIMSE Verification/Storage receiving, generated demos, Docker, and portable runtime packaging.
