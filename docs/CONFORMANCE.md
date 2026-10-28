# First-release supported profile — 1.0.0-rc.1

EASI Store is a single-host DICOM archive for research, software development and
authenticated shared deployments. It uses one SQLite catalog and local
filesystem object storage, with one writer per archive directory. This document
defines the release's product scope; it is not a declaration of complete DICOM
conformance, Orthanc REST/plugin compatibility, or clinical qualification.

| Area | Supported first-release profile |
| --- | --- |
| Archival input | Structurally readable Part 10 files with required valid hierarchy/SOP/transfer-syntax UIDs; exact HTTP/file bytes preserved |
| Native DIMSE input | Encoded dataset preserved with a generated Part 10 wrapper; successful C-STORE follows durable archival commit |
| Identity | Patient ID plus issuer; missing issuer scoped to source; no automatic name-based identity merging |
| Duplicates | Byte-identical repeated SOP UID is idempotent; byte/hierarchy/patient conflicts fail explicitly |
| Query/retrieve/store | Documented [DICOMweb](DICOMWEB.md) subset and [DIMSE](DIMSE.md) Verification/Storage/Study Root/Patient Root profile |
| Viewing | Published EASI View SDK **1.0.0-rc.1**, pinned and qualified as this Store's embedded viewer; display support is independent of archival acceptance |
| Research | Saved series selections, immutable exact-membership/hash manifests, optional source-scoped subject splits, verified Python downloads; no automatic anonymization, segmentation labeling or model training |
| Identity/access | One local administrator; local, hybrid or one-provider OIDC; archive-wide Reader/Contributor/Administrator roles and expiring revocable service credentials |
| Hosted HTTP | Explicit public URL/hosted mode, authenticated access and a reviewed HTTPS reverse proxy; workstation research bypass is refused for declared hosted/public deployments |
| Native DIMSE access | Exact configured AE/source-IP admission; no native DICOM TLS or HTTP-identity mapping |
| Operations | Capacity safeguards, bounded read-only integrity reviews, recovery journals, original ZIP exports, confirmed removal, offline full backup/restore |

The protocol reference baseline is the PS3.18 **2026d** edition adopted during
development, with exact implemented transactions, representations and limits in
the versioned DICOMweb/DIMSE guides. Advanced standard families and unimplemented
representations remain outside the supported profile. Runtime capabilities
report the build's subset; they do not advertise every optional standard feature.

## Deployment and resource limits

- One application process, one archive directory and reliable local storage.
  SQLite directories shared across hosts/NFS and multiple writer replicas are
  outside the profile. Back up the catalog, security/configuration and originals
  as a unit using [the offline procedure](OPERATIONS.md#backups).
- The default maximum encoded instance is **512 MiB**. Intake defaults to eight
  concurrent instances, a 256 MiB reserve and additional per-import headroom.
  See [Archive health](HEALTH.md) for exact capacity/audit limits and failure
  semantics; the reserve is not an OS quota against unrelated processes.
- DIMSE defaults to eight associations and at most 10,000 query/retrieve items;
  transfer selections allow at most 100,000 instances, with serialized,
  checkpointed jobs. QIDO pages have a maximum of 1,000 results. Select smaller
  series when a documented bound is exceeded; no unlimited-resource claim is made.
- The embedded viewer's per-object, metadata, decoded-cache, codec and geometry
  limits still apply. Archive success does not promise image rendering for every
  stored object. Raw documents/non-image objects need their own display profile.
- Frozen dataset versions record membership; they do not retain deleted
  originals, establish cross-source patient identity, or remove identifiers.

The release publishes only platforms with candidate-specific native/container
evidence. The current native target matrix is macOS ARM64, Windows x64 and Linux
x64; Linux containers target AMD64 and ARM64 after their native runtime gates.
Other recognized packager targets are not implied to be qualified. Portable
archives are unsigned; native signed/notarized installers and managed-service
installers remain separate work.

## Evidence and support boundary

[VALIDATION.md](VALIDATION.md) identifies exact qualified commits, artifacts,
protocol clients, fault/recovery exercises and measured workloads. These are
bounded engineering tests, not a clinical safety assessment or a promise of
universal modality/PACS/network compatibility. Production users must qualify
their actual topology, identity provider, backup/recovery and workload.

The OIDC profile is authorization code + PKCE with RS256 ID tokens and explicit
subject/group grants. The reproducible hosted check uses real Keycloak behind
HTTPS; the Entra ID/Okta recipes need tenant-specific validation. SAML, SCIM,
instant directory synchronization and patient/tenant-specific permissions are
outside the first release.

The [EASI Community License](../LICENSE) covers eligible use, including its
USD 5 million Organization Group revenue threshold and commercial-license
requirements. Security reports use [the private reporting policy](../SECURITY.md).
