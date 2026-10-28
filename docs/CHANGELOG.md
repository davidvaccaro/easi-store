# Changelog

## 1.0.0-rc.1 — First-release readiness candidate

- Add administrator Archive health, live filesystem capacity admission, bounded concurrent intake, revisioned persisted reserves, and separate process/readiness endpoints.
- Add bounded/cancellable inventory and full original SHA-256 reviews, private durable partial reports, and an offline `verify` command. Findings never trigger automatic repair or deletion.
- Refuse local-research access in declared hosted/public deployments and reject proxy indicators for anonymous workstation bypass. Qualify a real Keycloak/HTTPS profile with generated role accounts.
- Add reusable corpus, mixed-workload/crash/restore, exhausted-container-storage and independent interoperability qualification tools. Keep original corpora and private reports outside published inputs.
- Prepare versioned native bundles and AMD64/ARM64 container publication gates with checksums, dependency inventories, security reporting and exact-candidate evidence. Omit unused package-manager tools from bundled runtimes.
- Retain catalog schema3, authentication version2, original bytes and exact published EASI JS/View dependencies. This is the supported single-host research/development candidate, not full Orthanc parity or clinical qualification.

## 0.6.0 — Local and organizational identity preview

- Add explicit local, hybrid and OIDC HTTP sign-in modes, retaining one built-in local administrator and a deliberate operator recovery boundary.
- Map configured issuer/subject or organization group identities to reader, contributor or administrator; unmapped users are denied and email does not link accounts.
- Enforce shared role permissions across browser sessions and Store API credentials, including DICOMweb, exports, frozen dataset reads/hash checks, imports, curation, destructive operations and administration.
- Add live named/expiring credential creation, redacted listing and revocation, local-session password change, offline password-file reset and principal-attributed administrative actions. Keep secrets outside URLs, audit records, client bundles and portable manifests.
- Preserve anonymous loopback research as a separate DICOMweb-only exemption; supplied reader/invalid credentials do not acquire write rights. Native DIMSE retains its separately configured AE/IP policy.
- Upgrade local authentication state to version2 and catalog schema3 as a security downgrade fence; older runtimes refuse role-aware archives. Preserve a verified pre-upgrade full backup for rollback; original DICOM bytes are unchanged.
- Remain a source-available preview. Synthetic-provider protocol qualification does not certify Entra ID, Okta, Keycloak, an organizational deployment, fine-grained tenancy or clinical/production readiness.

## 0.5.0 — Reproducible research datasets preview

- Add a Datasets workspace for named cross-study series selections, dataset-level organizational labels/review notes, indexed technical readiness, and visual review in the independent EASI View.
- Freeze immutable version manifests with exact original instance membership, SHA-256/byte sizes, provenance, and optional explicit seeded subject-grouped train/validation/test splits. Later imports do not change frozen membership; snapshots do not pin originals against removal.
- Add availability/hash checks, manifest downloads, version-specific Python consumer commands, and bounded resumable downloads that verify originals before producing a report/datalist. Credentials stay separate from manifests.
- Add a generated six-subject/twelve-study/36-image cohort and confirmed metadata-only dataset removal. Removing a definition/version history does not remove archived DICOM originals.
- Provide an optional MONAI CPU example qualified for generated native Little Endian MONOCHROME2 2D and multiframe inputs. Spatial series stacking, SEG-to-mask conversion, annotation validation, model training/inference, and anonymization remain outside this profile.
- Keep Node 24 as the Store runtime. Python 3.9+ is needed for the optional consumer and its tests; ML dependencies are separate. This remains a source-available preview, not stable 1.0 or clinical qualification.

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
