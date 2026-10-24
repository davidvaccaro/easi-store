# Preview validation

Validation uses independently generated DICOM fixtures. Original imaging collections are not part of the source, build, test suite, or artifacts.

## Automated checks

`npm run check` validates source assets, synthetic archive/protocol/authentication/backup cases, portable argument/checksum handling, TypeScript, production UI build, and distribution hashes. Tests exercise actual local HTTP and DIMSE sockets; environments must permit loopback listeners.

Covered boundaries include disk-backed ingest, original-byte retrieval, duplicate/conflict handling, malformed/truncated/oversized inputs, issuer/source patient identity, restart and directory ownership, interrupted-write recovery, corrupt recovery failure, QIDO hierarchy/matching/pagination, mixed STOW outcomes, split MIME boundaries and false binary prefixes, unsupported content negotiation, authentication/CSRF/host checks, administrator setup races, durable DIMSE acknowledgment, and offline backup/restore with corrupted-backup rejection.

## Phase 2 — 0.2.0

The Phase 2 synthetic peer/job tests exercise actual sockets and streamed WADO/STOW/C-STORE/durable C-GET round trips; original WADO byte hashes match. They also verify missing/wrong SOP acknowledgment rejection, fixed destinations/no redirects, hidden named credentials, persistent instance checkpoints, restart recovery, manual retry, cancellation cleanup, and changed-destination guards. The targeted 10-test connection/job suite passed; after the strict hierarchical DIMSE enumeration adjustment, its three real transfer tests passed again. Candidate-wide test/build/browser/container results should be recorded for the exact finalized source, separately from this targeted evidence.

Independent Orthanc **1.12.8**, isolated from existing archives and using only generated objects, passed ten Phase 2 interoperability checks on 2026-10-24: Orthanc→Store C-ECHO, C-FIND values, C-GET and configured C-MOVE; Store→Orthanc durable C-GET receiving; exact encoded-dataset round trip; configured remote C-FIND/enumeration; and three-instance queued C-GET/C-STORE jobs. This exposed and corrected repeated identical Storage role-negotiation responses and ensured whole-study discovery uses SERIES followed by IMAGE queries with unique parent keys. No private medical data or existing Orthanc database was used.

### Integrated Phase 2 checks — 2026-10-24

The integrated Store passed **81 synthetic automated tests**, TypeScript checks,
source-asset guards, the production build and all 59 distribution-file hashes.
This includes nested metadata/frame/bulk correctness, numerical thumbnail PNG
expectations, signed/high-bit samples and presentation inversion, requested-series
identity before commit, aborted/malformed peer-stream cleanup, and durable job
checkpoints/cancellation. Public tests use generated data only.

Disposable native Chrome checks verified standalone EASI View opening and seeking
through a 12-instance synthetic study over both DICOMweb and actual DIMSE. The SDK
also opened the same archive in native-frame mode, fetching selected `/frames/1`
resources without downloading complete instances. Logging out of Store made both
bridges return 401. Management UI checks covered lazy thumbnails, peer creation,
C-ECHO, patient search, queued durable retrieval, acknowledged progress, editing,
and a 390 px mobile layout without page overflow. Successful workflows produced
no runtime exceptions or external requests; deliberate post-logout requests
produced their expected 401 errors.

The 0.2.0 Docker Linux ARM64 image passed non-root UID 10001, read-only root
filesystem, private volume, bootstrap, original-byte retrieval, nested metadata,
selected frames, thumbnail rendering, configured DIMSE C-ECHO, a checkpointed
C-GET retrieval job, and restart/login/original-byte persistence checks using only
synthetic data. This is container evidence on this platform, not a universal
production qualification.

The final macOS ARM64 0.2.0 portable bundle passed inventory verification of
5,322 files and the expanded launcher smoke using bundled Node 24.22.1 with no
system Node on PATH. It retained 12 generated demo instances plus one independent
nested/multiframe fixture across three launches. Exact native frame and nested
bulk bytes, metadata resources, protected routes, trusted proxy prefixes, PNG
thumbnails, persistent peer CRUD and duplicate-safe queued STOW/WADO jobs passed.
Windows/Linux 0.2.0 portable results are recorded separately after native CI.

The local 0.1.0 archive was upgraded after a private offline backup without
reimporting images. Aggregate study/series/instance/byte counts were unchanged,
and all 2,992 original object SHA-256 hashes matched the backup after the upgrade.
No original images, identifiers, account data, or backup contents are included in
source or artifacts.

The protocol profiles still have explicit limits. Synthetic success and one independent peer do not certify every modality, SOP class, network condition, OS artifact, or full-standard option. The native portable matrix below is a **0.1.0 baseline**, not a claim that the 0.2.0 artifact has passed the same matrix.

## Foundation 0.1.0 runtime checks on 2026-10-24

- Native macOS ARM64: first-run account, synthetic study creation, library navigation, instance/series viewing with the published EASI View SDK, extensionless import, duplicate and invalid-input feedback, connection test, mobile layout/navigation, and logout. Real grayscale pixels displayed; no external requests or runtime exceptions occurred. The intentionally invalid input returned the expected error.
- Docker Linux ARM64, Node 24.22.1: image built, ran under UID 10001 with a read-only root filesystem and private persistent volume; bootstrap setup, upload, original-byte retrieval, stop/restart, login, and byte-identical retrieval passed.
- Independent Orthanc 1.12.8 in a disposable local configuration: Verification C-ECHO and Storage C-STORE to EASI Store succeeded. No existing Orthanc database or original medical files were used.
- Portable macOS ARM64: bundled official Node 24.22.1, file inventory verification, launcher with no system Node in PATH, setup, synthetic import, restart/login, and persisted counts passed.

## Foundation 0.1.0 native portable CI baseline

The [successful portable matrix on 2026-10-24](https://github.com/davidvaccaro/easi-store/actions/runs/40103493426) ran on native macOS, Windows, and Linux runners. Each passed all 27 synthetic tests, TypeScript validation, the production build/distribution verification, runtime-bundled packaging, and the actual portable launcher smoke check. The smoke verified the artifact inventory and Node 24.22.1, launched without a system Node on PATH, created the administrator, imported 12 synthetic instances, and confirmed counts/bytes after restart. Windows packaging used the native x64 runner and Linux used the native x64 runner; local macOS ARM64 validation is recorded above.

The smoke now also uses an archive directory containing spaces, `&`, and `!` to exercise literal path handling. A baseline success does not certify every OS version or architecture; review the workflow run for the exact candidate being distributed.

Signed installers, multi-node durability, sustained performance, broad independent modality interoperability, production deployment qualification, and full DICOMweb conformance remain release gates in [BACKLOG.md](BACKLOG.md).
