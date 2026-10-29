# Preview validation

Validation uses independently generated DICOM fixtures. Original imaging collections are not part of the source, build, test suite, or artifacts.

## First-release readiness — 1.0.0-rc.1, 2026-10-28

The integrated candidate passed **304 synthetic tests**, source-asset checks,
TypeScript, the production UI build and all 64 distribution hashes on macOS
ARM64/Node 24.22.1. Forty-four new cases cover shared capacity admission, actual-write
failure mapping, bounded/cancellable audits, malformed persisted state, hosted
access, health HTTP/CLI authorization and the corpus qualification harness.

Disposable Chrome passed **13 Archive health checks** with generated originals:
revisioned safeguards, stale updates, readiness distinct from liveness, preserved
original bytes, real missing/corrupt/orphan/unsafe findings, hash-vs-inventory
mode, cancellation/partial results, polling cleanup and 390 px layout. No runtime
or console errors occurred. The existing identity/dataset suites remain covered
by their separate earlier workflow evidence and current native portable gates.

A real **Keycloak 26.8.1** server behind **Caddy 2.11.7 HTTPS** passed ten generated
realm/browser checks: actual code/PKCE/RS256/Basic login for Reader, Contributor
and Administrator, exact group permissions and original hashes, QIDO/import/admin
boundaries, unmapped denial, all logout flows and Secure/HttpOnly/SameSite cookies.
CA verification remains enabled; an untrusted connection fails. Anonymous and
forwarded-spoofed requests remain 401, bad Host/foreign Origin 403 and a hosted
research downgrade 400. No system trust setting, real tenant or user archive was
changed; synthetic containers/networks/profiles were removed. Entra ID and Okta
remain configuration recipes, not live-tenant qualification.

The reusable mixed-workload qualification drove **160 generated originals** with
four concurrent import workers, 650 query passes and 643 exact-original SHA reads.
A hard kill during a filesystem-observed unfinished upload was followed by
restart: all 160 acknowledged objects and hashes remained, and the partial import
was not indexed. A separate offline full backup/restore retained the hashes,
local login, Reader scope and revoked credential state; a restored full integrity
review reported no findings. This local run took about 15 seconds; it is bounded
recovery evidence, not a general throughput or concurrency guarantee.

The full explicitly local corpus run examined **26,162 files**: 16,143 unique
instances stored and retrieved byte-identically, 235 byte-identical duplicates,
7,485 explicit UID/hierarchy/patient conflicts, 104 rejected inputs and 2,195 files
without a supported Part10 prefix. There were no request/integrity failures.
The final full SHA review checked all 16,143 retained originals / 3,060,724,102 bytes
with zero missing, corrupt, unreferenced, unsafe or unreadable objects. The
approximately 12-minute run includes upload/query/download hashing and duplicate/
conflict cases, not viewer-rendering validation. Original inputs were opened
read-only, the disposable archive was removed, and per-file reports remain
private outside published source/artifacts. A rejected/conflicting file is not
silently treated as a successful archival import.

The Linux ARM64 production container passed **seven runtime/recovery groups**
with nonroot UID 10001, a read-only root, a private persistent volume and no Python.
The separate 64 MiB constrained tmpfs exercise acknowledged 52 generated originals,
reached the live intake guard, then forced actual OS ENOSPC with an unrelated
bounded filler. Readiness returned 503, liveness 200 and an auditable import 507.
After clearing only that filler and restarting the Store process in the same
container, all 52 original hashes and the full integrity review passed. A normal
private-volume container restart separately retained settings, audit reports,
roles and revocation. Temporary containers/volumes were removed.
Final npm/yarn-free image ID:
`sha256:bb21757e52425ec45237ae3025be5a90608e9c04ac1c2a8b400c8748e0009b3d`.
All 123 application/runtime-input files matched the qualified stage exactly
(payload SHA-256 `9e5f7715c251811d87c43842f951dc773d4db1e78d1e7d61fa22966667d5d28e`).
The volatile tmpfs exercise qualifies process recovery under storage pressure;
it is not a claim of persistence across a container/power loss on tmpfs.

Independent Orthanc 1.12.8 with DICOMweb 1.19 passed 12 protocol groups using
only generated CT with Explicit VR Little Endian: Verification both ways; Store SCP C-STORE, C-FIND at study/
series/image levels, C-GET and C-MOVE; Store SCU storage/find/durable get; explicit
low-space receiving failure; and authenticated QIDO/STOW/WADO both directions.
HTTP Part10 bytes and DIMSE encoded datasets are checked separately. This found
and fixed a narrowly recognized Orthanc 73-character repeated-UUID multipart
boundary exception, covered by four regressions without relaxing ordinary MIME
or resource bounds. The separate correlated move check retained whole-study,
series, instance, duplicate and missing-destination coverage. Existing user
Orthanc/configuration/storage were untouched; disposable servers were removed.
This independent matrix does not qualify compressed transfer syntaxes or DICOM
TLS; the declared protocol profile records those limits.

The final image's npm/application audit and pinned Trivy scan pass the policy
of no fixable HIGH/CRITICAL findings. Full retained reports include vendor-
unfixed/deferred Debian findings; [SECURITY_NOTES.md](SECURITY_NOTES.md) records
that boundary and the unused package-manager removal. The release is not claimed
to be vulnerability-free.

The [native release matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40761367181)
and [Check/Docker workflow](https://github.com/davidvaccaro/easi-store/actions/runs/40761294650)
passed for exact source `3a2dc21702400e33b6a4b1bb924edbb27d8bdc7f`.
macOS ARM64, Linux x64 and Windows x64 each passed **304 tests**, with zero skips
or cancellations, plus the actual bundled-runtime launcher smoke. Each portable
passed all nine identity, nine dataset, ten health and four supply-chain checks.
The only correction after the initial local qualification makes its Unix file-mode
assertion conditional on POSIX; no runtime behavior changed.

Each downloaded package was independently verified against GitHub's artifact
digest, its inner SHA-256 sidecar, every inventory file, 84 packaged source inputs
from the exact commit, and its root CycloneDX SBOM. Inventory counts are 3,492 on
macOS/Linux and 684 on Windows; Windows source comparisons account for CRLF.
Bundled Node 24.22.1 starts without system Node, npm or Python. Release archives
are unsigned portable packages, not signed operating-system installers.

| Native package | SHA-256 |
| --- | --- |
| macOS ARM64 | `628e4e24b895cab84cade35af8b42f2de52651da7c623aa7476bdc2cf81ef800` |
| Linux x64 | `00e962a216db2079adfa76393c7d686bb4c70538a580d436a5b23215ac763950` |
| Windows x64 | `df96d87afe76c2c6002fa9daf7d9eebe342c6a50a79d860ea1cacd5c0fc9ac46` |

Before upgrading the local archive, a fresh protected offline backup was checked:
all 2,998 backup entries and all 2,992 original hashes matched. The candidate
retained one patient, two studies, 20 series, 1,596,352,936 original bytes, both
configured peers, dataset state, exact authentication state and client-access
policy. The running version reports 1.0.0-rc.1; no original was rewritten.

The [qualified container publication](https://github.com/davidvaccaro/easi-store/actions/runs/40762039854)
passed for that same source. Each native Linux AMD64/ARM64 build passed all seven
actual-container groups, including real constrained-filesystem exhaustion and
recovery, plus runtime dependency audit, full-image scan and the no-fixable-
HIGH/CRITICAL publication gate. Both full reports retain 229 findings, including
vendor-unfixed/deferred entries; the gate does not mean zero total findings.
A first-package registry manifest-write denial on AMD64 was resolved by retrying
the failed job; no code or permissions changed, and the retried image was rebuilt,
qualified and scanned again before publication.

The published `ghcr.io/davidvaccaro/easi-store:1.0.0-rc.1` index is
`sha256:e20088872a42ce8c7587de62a353631cb4fd663d19a9e4cc3af6624bc8480ba4`.
Its Linux AMD64 manifest is
`sha256:03e2701310dfa20ca458d2f29901b1c49f71ab32e4a46c2d6d0ee1d51f7e4900`;
Linux ARM64 is
`sha256:a9f8423d8e6bdbb83cf07e00d9486d894db37c6ba1d23ea34b753092c91e33bf`.
These CI images have their own qualification receipts; the earlier local image
ID above is not substituted for a published image digest.

[Release downloads](https://github.com/davidvaccaro/easi-store/releases/tag/v1.0.0-rc.1)
include the three native bundles, SHA-256 sidecars, `SHA256SUMS`, per-platform
CycloneDX inventories and sanitized validation/security reports. Private corpus
per-file reports, archives and deployment credentials are excluded. Source is
published under the Community License. Exact-candidate receipts remain retained
under ignored local artifact directories; later documentation-only commits do
not change the qualified runtime or replace the tagged package contents.

Anonymous HTTP verification confirmed the public repository, README, license,
health guide and release tag, then downloaded all **12 original release assets** and
matched their exact sizes/SHA-256 without credentials. The release tag points
to the qualified source above.

On **2026-10-29**, anonymous GHCR verification matched the exact published index,
both Linux AMD64/ARM64 manifests and image configurations, including qualified
source/version labels. Actual Docker pulls of both platforms succeeded with an
isolated empty Docker configuration and no registry login. Public image access
is enabled; the qualified image digests and original release downloads are
unchanged. The [supplemental container-access receipt](https://github.com/davidvaccaro/easi-store/releases/download/v1.0.0-rc.1/easi-store-1.0.0-rc.1-anonymous-container-verification.json)
and its SHA-256 sidecar are attached to the release.
These results qualify the [declared first-release profile](CONFORMANCE.md),
not arbitrary PACS topologies, every stored object's rendering or clinical use.

## Local identity and OIDC — 0.6.0 preview, 2026-10-28

The integrated candidate passed **260 synthetic tests**, source-asset checks,
TypeScript, the production UI build and all 64 distribution hashes on macOS
ARM64 and in an offline Linux ARM64 test container. This includes 26 focused
authentication/OIDC cases and 12 independent HTTP-security groups. The ten real
Python consumer tests now use read-only credentials for their downloads.

A generated local identity provider exercises the actual maintained OIDC client,
RSA-signed ID tokens, discovery/JWKS, authorization-code exchange, PKCE, state,
nonce, exact callbacks and issuer/audience/expiry/signature validation. Unmapped
subjects, malformed group claims, replay, wrong browser binding, expired/bounded
transactions, unavailable providers and insecure endpoints fail closed. Tests
cover local credential migration, role ceilings, revocation, serialized writes,
recovery, and backup/restore preserving role-bound credentials and schema 3.

Disposable Chrome passed **18 workflow checks**: local setup, one-time token
display/revocation, incorrect/successful password changes, real OIDC redirects
for all three roles, Reader pixel display and frozen-version verification,
Contributor extensionless imports/versioning, Administrator controls, stale-role
403 handling, unmapped accounts, SSO-only and hybrid provider-outage behavior,
and a 390 px layout. No browser exceptions or console errors occurred. Tests
used no original medical files or real organizational credentials.

The final Linux ARM64 production image passed six runtime qualification groups:
Node 24.22.1, nonroot UID 10001, read-only root, private volume, no runtime Python,
role boundaries, byte-identical originals, schema 3, and credential/revocation/
snapshot persistence across restart. All 120 runtime input files matched the
frozen source. Image ID:
`sha256:0621cb0dbf2f4a046087d3c47e2a23d79c5982152bf26c9e761071e495031533`.
Synthetic containers and volumes were removed after qualification.

The macOS ARM64 portable bundle passed all **5,465 inventory files** and its
actual launcher smoke with bundled Node 24.22.1 and no system Node on PATH.
All existing archive/dataset/transfer smoke groups passed, plus nine identity
assertions: scoped roles, Reader original access, Contributor duplicate import,
protected management, scope persistence after restart, research non-escalation,
immediate revocation, principal attribution and the security schema fence.
Artifact SHA-256:
`c6c9c3cb8170fb036ba1d32afb0e21fe99c90a0e0f275aa13a572bb75e792768`.

The previously qualified actual 0.5.0 macOS package was independently started
against an upgraded disposable synthetic archive. It refused schema 3 before
opening the role-bound authentication state; authentication and original bytes
were unchanged, and 0.6.0 retained the Reader credential. This is a security
downgrade fence, not a reversible in-place downgrade. Restore a complete
pre-upgrade backup into a separate directory for rollback.

Before updating the local archive, 0.5.0 made a protected offline backup. All
2,998 backup entries and all 2,992 original hashes verified. The update retained
one patient, two studies, 20 series, 1,596,352,936 bytes, both configured peers,
dataset counts, the local administrator password hash and the local-research
profile. Authentication migrated to version 2 and the catalog to security
schema 3. Local sign-in remains configured; no organizational provider was
enabled and anonymous management remains protected.

Entra ID, Okta, Keycloak and generic OIDC guides have configuration examples
validated against Store's configuration parser and cite official provider
documentation. They are setup recipes, not evidence of live-provider tenant
qualification. The qualified protocol profile uses RS256 ID tokens and explicit
subject/group mappings. SAML, SCIM, certificate client authentication, back-channel
logout and immediate directory-group synchronization are outside this preview.

The [0.6.0 native portable matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40734648475)
passed on macOS ARM64, Linux x64 and Windows x64 for source
`ec49911d4e4c4c6ebf1322415cb3cb26c6703c8d`: all **260 tests** on each platform,
with zero skips or cancellations, TypeScript/build/distribution checks,
bundled Node 24.22.1 and the actual portable launcher smoke. Each platform
passed all nine identity and nine dataset assertions. The
[Check/Docker workflow](https://github.com/davidvaccaro/easi-store/actions/runs/40734578702)
also passed for that source. The Windows restore test closes its restored
database before removing the temporary parent directory; no runtime change
was required for that platform correction.

All three downloaded candidates were independently checked against GitHub's
artifact digests, inner SHA-256 sidecars, complete inventories and **78 tracked
release inputs** from the exact commit. Inventory counts were 5,465 on macOS,
5,465 on Linux and 2,665 on Windows; Windows text comparisons normalize line
endings. Verified packages and receipts are retained under ignored
`artifacts/native-ci/identity-ec49911/`. The local Docker/browser qualification
above exercises the same runtime inputs; the later correction changes only
test cleanup and deployment documentation. These checks qualify the named
preview profiles, not signed installers, live organizational tenants or a
stable-v1 release. Later documentation-only evidence commits leave the
qualified runtime unchanged.

## Research datasets — 0.5.0 preview, 2026-10-27

The integrated candidate passed **222 synthetic tests**, source guards,
TypeScript, the production UI build and all 61 distribution hashes on macOS
ARM64 with Node 24.22.1. Dataset coverage includes revision/confirmation guards,
immutable membership and manifest hashes, identity-scoped subject grouping,
explicit deterministic partitions, technical metadata review, bounded streaming,
missing/replaced/corrupt originals, shutdown/cancellation, authenticated access,
and full CLI backup/restore of definitions, versions and original bytes.

Ten independent Python-consumer tests exercise the actual authenticated HTTP
service, pinned manifests, original hashes, interrupted downloads, verified resume,
missing/corrupt originals, redirects, unsafe paths and cross-partition rejection.
Disposable Chrome passed **13 workflow checks**, including six-subject selection,
embedded image display, explicit freezing, manifest download, hash verification,
new imports leaving v1 unchanged, executing the displayed pinned-v1 command after
v2 exists, metadata-only removal, the one-click generated cohort and a 390 px
layout. No runtime exceptions or console errors occurred.

A real, isolated Linux ARM64 MONAI test used Python 3.12.16, MONAI 1.6.1,
CPU PyTorch 2.8.0, NumPy 2.2.6 and pydicom 3.0.1. Authenticated Store download,
the independent Python consumer, `load_decathlon_datalist`, `Dataset`,
`PydicomReader` and channel-first tensor loading succeeded. All decoded/rescaled
pixels matched independent expected values for native monochrome 2D
`[1, 8, 12]` and three-frame `[1, 3, 6, 10]` CPU tensors. Reader execution had
network access disabled. This qualifies that example profile, not compressed
codecs, spatial volume assembly, SEG masks, model training or clinical use.

The Linux ARM64 Docker image passed **221 full-suite tests plus the final
backup/restore test separately**, followed by nine production-runtime workflow
groups. These covered nonroot UID 10001, read-only root, a private volume, no
runtime Python, exact frozen manifest/original hashes, protected routes, the
actual served Python downloader and verified resume, two restart cycles and
metadata-only dataset removal retaining originals. All 109 runtime payload files
matched the frozen source. Image ID:
`sha256:60720b90d524e6f96e94d1134efc60691e78996523858eba611cae5c49f6f7f9`.
Disposable containers, networks and volumes were removed.

The macOS ARM64 portable bundle passed all **5,354 inventory files** and the
expanded launcher smoke with bundled Node 24.22.1 and no system Node on PATH.
In addition to existing archive/protocol/transfer checks, the smoke covered
dataset selection/readiness, immutable manifests, exact frozen originals,
hash availability, authenticated management/downloads, the packaged consumer,
missing originals and restart persistence. Artifact SHA-256:
`b8903a9c37b0a2a7ca77bcc155a30777fcc6c8e6ee9c37f488d0c9528dbedd53`.
Before updating the local archive, the prior 0.4.0 runtime made a fresh protected
offline backup. All 2,998 backup entries and all 2,992 original object hashes
verified. The 0.5.0 startup retained one patient, two studies, 20 series,
1,596,352,936 bytes, catalog schema 2, both configured connections and their
C-GET default. Local research remained enabled and anonymous management remained
401. No test cohort was added to the existing archive. Backup verification used
a separate catalog copy to leave the protected backup unchanged.

The [0.5.0 native portable matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40595549253)
passed on macOS ARM64, Linux x64 and Windows x64 for source
`fbf29b4ca052f60d10143831b5913c48c4f9501e`. Each platform passed **222 tests**,
TypeScript/build/distribution checks, runtime packaging with Node 24.22.1 and
the complete launcher smoke, including all nine new dataset assertions. The
[Check/Docker workflow](https://github.com/davidvaccaro/easi-store/actions/runs/40595473218)
also passed for that source.

Downloaded native candidates were independently verified against GitHub artifact
digests, inner SHA-256 sidecars, every regular payload inventory entry and all
65 packaged tracked release inputs, including source, docs and executable Python
examples. Windows source comparison normalizes line endings. Inventories contain
5,354 files on macOS/Linux and 2,554 on Windows. Verified packages and synthetic
receipts remain under ignored `artifacts/native-ci/datasets-fbf29b4/`. No archive
data or credentials were copied into those artifacts. Later documentation-only
evidence commits do not change this qualified runtime. Stable-v1 publication and
production qualification remain separate gates.

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

The [0.3.0 native portable matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40196077113)
passed on macOS ARM64, Windows x64 and Linux x64 for source
`20a749426f8494aaabdf4ea4d27ca5fb458b3266`. Each runner passed all 137 tests,
TypeScript/build/distribution checks, packaging with bundled Node 24.22.1 and
the expanded launcher smoke, including original ZIP/manifest verification,
typed removal, physical reclamation, unselected-study retention and restart.
The [Linux checks and Docker build](https://github.com/davidvaccaro/easi-store/actions/runs/40196053721)
also passed for the same source. These are preview qualifications for the named
profiles/platforms, not signed installers or a stable-v1 release declaration.

## Correlated C-MOVE — 0.4.0 preview, 2026-10-26

The integrated macOS ARM64 candidate passed **188 generated-data tests**, source
asset checks, TypeScript, production build and all 61 distribution hashes under
Node 24.22.1. New coverage includes the real callback receiver, durable ACK gates,
expected study/series/SOP/class, originator AE/message ID, calling AE and source IP,
missing callbacks, unknown destinations, duplicate retrieval, invalid/failure
responses, partial reception, cancellation, late callbacks, deadlines, failed
persistence, receiver closure, safe diagnostics and queue retry/restart. Allocation
quarantine, the next message ID and bounded historical originator AEs persist
across restart. Tests inject a state-write failure to prove import reservations
are released; early remote final responses cannot leave a receiving stream stuck.
Empty PDVs are rejected instead of growing zero-byte fragment arrays.

Three real-CLI tests verify listener-before-queue startup, disabled-receiver
failure without remote enumeration, and interruption before any callback followed
by successful restart. POSIX checks verify queued shutdown intent; the Windows
case allows forced process termination and requires recovery on next startup.
Existing C-GET/DICOMweb tests remain part of the full suite.

The optional independent check is reproducible with an installed Orthanc binary:

```sh
node scripts/qualify-orthanc-move.mjs /absolute/path/to/Orthanc
```

It starts an isolated Orthanc with generated objects and never connects to an
existing archive. Orthanc **1.12.8** passed whole-study (4), selected-series (2),
and single-instance (1) C-MOVE jobs, exact encoded-dataset hash comparisons,
duplicate retrieval and missing-destination failure despite a preexisting object.
Its control calling AE differs from the receiving AE. Native tests separately
cover standard A801 unknown-destination diagnostics; a peer may instead return a
less-specific failure status. This evidence qualifies the documented same-AE/IP,
originator-bearing callback profile, not arbitrary multi-host PACS topologies.

Disposable Chrome passed **8 connection UI checks**, including persisted C-GET /
C-MOVE editing, fixed receiver guidance, real C-ECHO and its callback disclaimer,
synthetic remote search, disabled receiver copy and readable 390 px layout.
There were no runtime exceptions, console errors or external requests.

The Linux ARM64 runtime image passed **8 existing smoke groups** and **4 additional
cross-container C-MOVE groups** under Node 24.22.1. The latter use a private bridge
with exact remote AE/IP trust, real callbacks, encoded-dataset hash verification,
duplicate retrieval and restart persistence. Image ID:
`sha256:ffcda89d83aa67297329e2a6cfbd50a7589725a71f9fb61ff4942a1ac1d593b5`.
The image's 91 runtime/build/package/notice files matched the tested source.
Synthetic test containers, network and volume were removed after qualification.
Cross-platform native packages are qualified separately for the pushed source;
these local results are not a stable release or production qualification.

The default IPv4-only Linux ARM64 Docker check also passed all **188 tests**
with zero skips, followed by TypeScript/build/distribution checks; no IPv6
container option is required. The source-IP rejection fixture exercises the
active guard during a real IPv4 operation, and a correct actual callback then
succeeds. Other callback mismatch cases use real sockets throughout.

Before the local update, the prior 0.3.0 build made a protected full offline
backup. All 2,998 backup entries and all 2,992 live original hashes verified.
After startup, archive totals remained one patient, two studies, 20 series and
1,596,352,936 bytes; both saved connections and their C-GET default were retained.
Local research persisted, and unauthenticated management requests remained 401.
No existing Orthanc configuration or imaging data was used or changed by these
qualification checks.

The macOS ARM64 local portable bundle passed all **5,346 inventory files**
and the actual launcher smoke with bundled Node 24.22.1 and no system Node on
PATH. Original ZIP/CRC/SHA-256, typed removal, physical reclamation, protected
administration, access persistence and restart passed. Artifact SHA-256:
`838ba038cd004d7806064b32766414a92404efc230d071b79d45a2774e86b7b1`.
Synthetic-only receipts are retained under ignored `artifacts/cmove-040/`.

The [0.4.0 native matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40369005639)
passed on macOS ARM64, Linux x64 and Windows x64 for source
`f5d564a18a9c1b36318f9c45235d4a1c4774b987`: all 188 tests on each platform,
TypeScript/build/distribution checks, runtime-bundled packaging and the full
portable launcher smoke. The [Check/Docker workflow](https://github.com/davidvaccaro/easi-store/actions/runs/40368920426)
also passed for that source. All three downloaded candidates were independently
verified against GitHub artifact digests, inner SHA-256 sidecars, complete file
inventories and 57 tracked release inputs; Windows source comparison normalizes
line endings. Verified packages/receipts are retained under ignored
`artifacts/native-ci/cmove-f5d564a/`. These qualify the named preview profiles;
platform signing, stable-v1 publication and production qualification remain
separate gates. Later documentation-only evidence commits do not change this
qualified runtime source.
