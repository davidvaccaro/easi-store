# Changelog

## 0.3.0 — v1 workflow preview

- Metadata-first, on-demand embedded viewing through the independently published EASI View SDK; avoids whole-series prebuffering and retains exact instance targeting/cancellation.
- Authenticated original study ZIP/ZIP64 download with UID-only paths and a SHA-256 integrity manifest; streaming/backpressure, bounded snapshots, cancellation, and corruption rejection.
- Confirmed study removal with count/byte/revision preview, typed DELETE, active-reader/import/transfer protection, auditable counts, original hash checks, and durable interrupted-removal recovery.
- Catalog schema 2 preserves existing objects/history. Take a verified offline backup before upgrading; older builds refuse the migrated catalog and rollback requires the prior backup.
- MIT-licensed yazl/buffer-crc32 added for ZIP generation with retained license notices. Still a preview; see candidate-specific validation and the stable-v1 gates.


See the [release changelog](../CHANGELOG.md) for versioned changes.
