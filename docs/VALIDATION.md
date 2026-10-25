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
The [0.2.0 native portable matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40125121830)
passed on source `ea502317bd74b56d72f08b5c19e06a4775e6ebc9` for macOS ARM64,
Windows x64 and Linux x64. Each passed all 81 tests, typecheck/build/distribution
verification, bundled Node 24.22.1 packaging and the same expanded 13-instance
installation/metadata/frame/bulk/thumbnail/peer/transfer/restart smoke. The separate
[Linux check and Docker build](https://github.com/davidvaccaro/easi-store/actions/runs/40125122317)
also passed. An earlier CI attempt exposed macOS-only temporary paths in four test
files; these now use `os.tmpdir()` and the successful matrix includes that fix.

The local 0.1.0 archive was upgraded after a private offline backup without
reimporting images. Aggregate study/series/instance/byte counts were unchanged,
and all 2,992 original object SHA-256 hashes matched the backup after the upgrade.
No original images, identifiers, account data, or backup contents are included in
source or artifacts.

The protocol profiles still have explicit limits. Synthetic success and one independent peer do not certify every modality, SOP class, network condition, OS artifact, or full-standard option. The historical portable matrix below remains the **0.1.0 baseline**; the current 0.2.0 matrix is recorded above.

## Foundation 0.1.0 runtime checks on 2026-10-24

- Native macOS ARM64: first-run account, synthetic study creation, library navigation, instance/series viewing with the published EASI View SDK, extensionless import, duplicate and invalid-input feedback, connection test, mobile layout/navigation, and logout. Real grayscale pixels displayed; no external requests or runtime exceptions occurred. The intentionally invalid input returned the expected error.
- Docker Linux ARM64, Node 24.22.1: image built, ran under UID 10001 with a read-only root filesystem and private persistent volume; bootstrap setup, upload, original-byte retrieval, stop/restart, login, and byte-identical retrieval passed.
- Independent Orthanc 1.12.8 in a disposable local configuration: Verification C-ECHO and Storage C-STORE to EASI Store succeeded. No existing Orthanc database or original medical files were used.
- Portable macOS ARM64: bundled official Node 24.22.1, file inventory verification, launcher with no system Node in PATH, setup, synthetic import, restart/login, and persisted counts passed.

## Foundation 0.1.0 native portable CI baseline

The [successful portable matrix on 2026-10-24](https://github.com/davidvaccaro/easi-store/actions/runs/40103493426) ran on native macOS, Windows, and Linux runners. Each passed all 27 synthetic tests, TypeScript validation, the production build/distribution verification, runtime-bundled packaging, and the actual portable launcher smoke check. The smoke verified the artifact inventory and Node 24.22.1, launched without a system Node on PATH, created the administrator, imported 12 synthetic instances, and confirmed counts/bytes after restart. Windows packaging used the native x64 runner and Linux used the native x64 runner; local macOS ARM64 validation is recorded above.

The smoke now also uses an archive directory containing spaces, `&`, and `!` to exercise literal path handling. A baseline success does not certify every OS version or architecture; review the workflow run for the exact candidate being distributed.

Signed installers, multi-node durability, sustained performance, broad independent modality interoperability, production deployment qualification, and full DICOMweb conformance remain release gates in [BACKLOG.md](BACKLOG.md).

## Access-profile update — 0.2.1

All 91 Store synthetic tests, TypeScript checks and the build/distribution guards
pass for the access-profile update. Tests cover authenticated default behavior,
loopback-only research DICOMweb and DIMSE access, protected administration,
standard STOW without custom cookie-CSRF headers in research mode, persisted
profile changes, exact AE/IP trust, no wildcard research exposure, and older
backup compatibility. Viewer tests cover plain-name prefix matching, typed HTTP status preservation,
safe sign-in links and retained state.

Disposable Chrome passed 24 Store administration assertions: explicit saves,
research versus authenticated client access, protected management, trusted-client
validation/persistence/removal, Discard, accurate listener details, mobile layout,
no runtime exceptions and no external traffic. Separate browser runs exercised
both viewer protocols without cookies and actual image display/navigation; secure
mode blocked subsequent unauthenticated requests immediately. Actual sign-in in
separate tabs and expiry during admission retained criteria/checked studies for
explicit retry without duplicate admission.

The local archive was backed up offline before this update. All 2,992 original
object hashes remained identical after upgrading; no medical files entered source,
public test fixtures, or artifacts. Earlier 0.2.0 native package results above
remain historical; current package qualification is recorded for its exact build.

The macOS arm64 0.2.1 portable bundle with Node 24.22.1 passed inventory and
checksum verification, launch with no system Node on PATH, generated-demo
intake, nested metadata and byte-exact bulk/frame retrieval, protected routes,
thumbnails, peer edits and transfer checkpoint persistence across restarts.
The expanded smoke also switched to research access without credentials,
verified management stayed protected, restarted and retained that profile,
then restored authenticated access and verified anonymous QIDO returned 401.
Artifact SHA-256: `423bf2af557cbcec5e3ff59747447f2ec295f8ab751d1c7c0de9678fb7702533`.

The [0.2.1 native portable matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40129497472)
passed on macOS arm64, Windows x64 and Linux x64 at source commit
`dd9bc8f7369ceca71246c8f4702fef4481c23f81`. Each native runner passed all 91 tests,
TypeScript/build/distribution checks, runtime packaging with Node 24.22.1, and
`package-smoke.mjs`, including explicit research access, protected administration,
profile persistence across restart and return to authenticated mode. The
[Linux check and Docker build](https://github.com/davidvaccaro/easi-store/actions/runs/40129484241)
also passed for that commit.

A disposable Linux arm64 Docker 0.2.1 image additionally passed runtime checks
with generated data: nonroot UID 10001, read-only root, persistent archive volume,
HTTP-only port publication and DIMSE bound to container loopback. Authenticated
query/retrieve, byte-identical originals, nested metadata, frames, thumbnails,
internal DIMSE echo and durable C-GET jobs succeeded. Selecting local research
on the container's network HTTP listener was rejected without weakening the
active policy. Restart retained the archive and invalidated the old browser
session as expected. The disposable container and volume were removed.

Verified native packages and a checksum receipt were retained locally under the
ignored `artifacts/native-ci/access-dd9bc8f/` directory; the receipt pins the source
commit, workflow and exact artifact digests. No private archive content is included.

## V1 workflow milestone — 0.3.0 (2026-10-25)

The integrated candidate passes **137 synthetic tests**, TypeScript checks,
source-asset guards, the production UI build and all 61 distribution-file hashes.
New tests include independent ZIP/ZIP64 directory/CRC/SHA-256 verification,
backpressure, bounded export admission, cancellation/corruption/missing originals,
removal preview/confirmation/revision checks, physical reclamation and shared
reference protection, schema-1 migration, interrupted pre/postcommit recovery,
conflicting journals, pending HTTP/DIMSE imports and active transfer/read guards.
Paused original/WADO readers cannot stall shutdown indefinitely. Native socket
tests also pause an accepted C-STORE before its first dataset fragment: its
reservation blocks removal and is released on completion/error/disconnection;
a command rejected during removal cannot retry admission after the gate clears.

Disposable Chrome exercises a generated **260-instance, 130.3 MiB** CT series.
Opening requested one original; seeking to image 260 requested one more, and
both displayed. Exact-instance opening at 5 and Next to 6 retained correct SOP
identities. Native browser ZIP download completed and an independent Python
`zipfile`/SHA-256 pass verified all 260 originals. Canceling removal preserved the
study; adding an instance after preview produced the intended 409 and required a
new preview plus typed confirmation. Confirmed removal refreshed the library and
retained an unselected generated study. The 390 px removal dialog fit the screen.
No runtime exceptions or external requests occurred. Thumbnail worker saturation
retains the documented fallback icons; the deliberate stale-preview request
returns 409. All browser removals used a disposable synthetic archive.

Before upgrading the real local archive, the prior 0.2.1 build wrote a protected
offline backup, independently verified against all 2,998 manifest entries. It
retains the old schema, originals, security/configuration and rollback state.
The backup and imaging data remain outside source/artifacts. After upgrade, all 2,992 original SHA-256 hashes matched that backup; the one-patient, two-study, 20-series catalog and byte total were unchanged. Schema 2 opened successfully, the research profile persisted, and management remained protected. Historical 0.2.1 evidence does not qualify a changed build.

The final Linux ARM64 Docker image (Node 24.22.1) passed generated-data runtime
checks under nonroot UID 10001, read-only root and a private volume. Existing
metadata/frame/thumbnail/peer-transfer checks passed, followed by independent
original ZIP/CRC/SHA-256 verification, rejected lowercase/stale confirmations,
physical reclamation, deletion activity identity/counts, and restart without
resurrecting the removed study. The unselected original remained byte identical.
Image ID: `sha256:27ed9a4973dbdd06aa41f66325ce6f4624f286770a62f642855323856bd6e500`.
The disposable container and volume were removed.

The macOS ARM64 0.3.0 portable bundle passed verification of 5,343 inventory
files and the expanded smoke under bundled Node 24.22.1 with no system Node on
PATH. It exercised metadata/frame/bulk/thumbnail/protected-route/peer-transfer
and access-profile persistence, then exported the independent original, verified
ZIP/CRC/SHA-256, rejected invalid confirmation, removed only that study, checked
physical disk reclamation and restarted with all 12 unselected demo instances
intact. Packaged source and built assets match the final local candidate.
Artifact SHA-256: `76e0153cf617443341426a556cbab808e8e0d59b75e464eb1facf738c9ce5633`.
The package and synthetic-only receipts are retained under ignored
`artifacts/workflows-030/`. Cross-platform CI qualifies the exact pushed source
separately; this local result is macOS ARM64 only.
