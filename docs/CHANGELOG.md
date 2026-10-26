# Changelog

## 0.4.0 — Correlated C-MOVE retrieval preview

- Add per-DIMSE-connection C-MOVE retrieval alongside the default C-GET method, using the existing Store receiving AE and persistent instance queue.
- Correlate callback originator, source AE/IP and expected instance/hierarchy; acknowledge only after archival commit and require a valid final move outcome before checkpointing.
- Add callback setup guidance, safe actionable diagnostics, cancellation/retry/restart checks and listener-before-job startup ordering. C-ECHO remains a reachability test, not callback verification.
- Record an evidence-based proposed Dataset Snapshot Export priority for research/AI workflows; no AI training subsystem or anonymization feature is added.
- Keep schema 2 and existing originals, access controls and exact EASI JS/View dependency versions.

## 0.3.0 — v1 workflow preview

- Metadata-first, on-demand embedded viewing through the independently published EASI View SDK; avoids whole-series prebuffering and retains exact instance targeting/cancellation.
- Authenticated original study ZIP/ZIP64 download with UID-only paths and a SHA-256 integrity manifest; streaming/backpressure, bounded snapshots, cancellation, and corruption rejection.
- Confirmed study removal with count/byte/revision preview, typed DELETE, active-reader/import/transfer protection, auditable counts, original hash checks, and durable interrupted-removal recovery.
- Catalog schema 2 preserves existing objects/history. Take a verified offline backup before upgrading; older builds refuse the migrated catalog and rollback requires the prior backup.
- MIT-licensed yazl/buffer-crc32 added for ZIP generation with retained license notices. Still a preview; see candidate-specific validation and the stable-v1 gates.


See the [release changelog](../CHANGELOG.md) for versioned changes.
