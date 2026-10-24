# Foundation preview validation

Validation uses independently generated DICOM fixtures. Original imaging collections are not part of the source, build, test suite, or artifacts.

## Automated checks

`npm run check` validates source assets, synthetic archive/protocol/authentication/backup cases, portable argument/checksum handling, TypeScript, production UI build, and distribution hashes. Tests exercise actual local HTTP and DIMSE sockets; environments must permit loopback listeners.

Covered boundaries include disk-backed ingest, original-byte retrieval, duplicate/conflict handling, malformed/truncated/oversized inputs, issuer/source patient identity, restart and directory ownership, interrupted-write recovery, corrupt recovery failure, QIDO hierarchy/matching/pagination, mixed STOW outcomes, split MIME boundaries and false binary prefixes, unsupported content negotiation, authentication/CSRF/host checks, administrator setup races, durable DIMSE acknowledgment, and offline backup/restore with corrupted-backup rejection.

## Manual runtime checks on 2026-10-24

- Native macOS ARM64: first-run account, synthetic study creation, library navigation, instance/series viewing with the published EASI View SDK, extensionless import, duplicate and invalid-input feedback, connection test, mobile layout/navigation, and logout. Real grayscale pixels displayed; no external requests or runtime exceptions occurred. The intentionally invalid input returned the expected error.
- Docker Linux ARM64, Node 24.22.1: image built, ran under UID 10001 with a read-only root filesystem and private persistent volume; bootstrap setup, upload, original-byte retrieval, stop/restart, login, and byte-identical retrieval passed.
- Independent Orthanc 1.12.8 in a disposable local configuration: Verification C-ECHO and Storage C-STORE to EASI Store succeeded. No existing Orthanc database or original medical files were used.
- Portable macOS ARM64: bundled official Node 24.22.1, file inventory verification, launcher with no system Node in PATH, setup, synthetic import, restart/login, and persisted counts passed.

## Native portable CI baseline

The [successful portable matrix on 2026-10-24](https://github.com/davidvaccaro/easi-store/actions/runs/40103493426) ran on native macOS, Windows, and Linux runners. Each passed all 27 synthetic tests, TypeScript validation, the production build/distribution verification, runtime-bundled packaging, and the actual portable launcher smoke check. The smoke verified the artifact inventory and Node 24.22.1, launched without a system Node on PATH, created the administrator, imported 12 synthetic instances, and confirmed counts/bytes after restart. Windows packaging used the native x64 runner and Linux used the native x64 runner; local macOS ARM64 validation is recorded above.

The smoke now also uses an archive directory containing spaces, `&`, and `!` to exercise literal path handling. A baseline success does not certify every OS version or architecture; review the workflow run for the exact candidate being distributed.

Signed installers, multi-node durability, sustained performance, broad independent modality interoperability, production deployment qualification, and full DICOMweb conformance remain release gates in [BACKLOG.md](BACKLOG.md).
