# AI dataset workflows — proposed direction

**Proposal, not implemented.** The recommended next research feature is a small dataset snapshot export, subject to the release gates in [BACKLOG.md](BACKLOG.md). It would help developers select, inspect, and reproduce the exact data supplied to an experiment. It does not add model training, AI interpretation, an annotation marketplace, or clinical qualification.

Store already provides original-byte hashes, selected DICOMweb access, explicit transfers, original-study ZIP exports, and embedded EASI View within their documented profiles. These are useful foundations; they do not establish a complete training-data platform or tested MONAI interoperability. [STATUS.md](STATUS.md), [DICOMWEB.md](DICOMWEB.md), and [STUDY_MANAGEMENT.md](STUDY_MANAGEMENT.md) describe what is available now.

## Evidence for the workflow

These primary sources document practical workflows and evaluation guidance. They do not measure demand for EASI Store, market share, or willingness to pay.

| Need | Documented evidence | Design implication |
| --- | --- | --- |
| Reproduce dataset membership | IDC versions data and exports cohort manifests. DICOM UIDs alone do not freeze the content of a study or series as objects are added or corrected. | Record exact instance membership and content hashes, rather than only a search or Study Instance UID. [IDC versioning](https://learn.canceridc.dev/data/data-versioning), [cohort manifests](https://learn.canceridc.dev/portal/cohort-manifests) |
| Keep evaluation partitions independent | RSNA CLAIM recommends patient-level or higher separation so that one patient's images do not appear in different partitions. | Preserve reliable subject grouping and avoid automatic slice-level splits. [CLAIM item 20](https://rsna.github.io/claim/item-20.html) |
| Associate inputs, annotations, and experiment versions | MONAI's Auto3DSeg datalists pair images with labels, support folds, and recommend dataset-version metadata. | Keep annotation relationships explicit. A collection tag is not a segmentation mask or a verified clinical label. [MONAI datalist example](https://github.com/Project-MONAI/tutorials/blob/main/auto3dseg/docs/run_with_minimal_input.md) |
| Select and inspect suitable series | IDC indexes acquisition metadata, source relationships for segmentations, and technical geometry checks. | Show known technical limitations and provide visual review. Import success does not prove a series is suitable for a particular training task. [IDC index reference](https://idc-index.readthedocs.io/en/latest/indices_reference.html) |
| Retrieve data programmatically | IDC supports manifest downloads and DICOMweb metadata/frame access. MONAI Label accepts DICOMweb archives as datastores. | Qualify one bounded, authenticated consumer path against the exact release. Compatibility must be tested before it is advertised. [IDC access methods](https://learn.canceridc.dev/data/downloading-data), [MONAI Label data preparation](https://github.com/Project-MONAI/MONAILabel#step-4-data-preparation) |

## Proposed first slice: dataset snapshot export

1. **Select and review.** Choose specific series across studies using supported library criteria. Review examples in EASI View, with patient/series/instance counts and known technical warnings. The initial selection can be transient; a persistent project or collection-management subsystem is not required.
2. **Freeze a manifest.** Export versioned JSON describing exact Study/Series/SOP identifiers, SHA-256 hashes, byte sizes, creation time, Store version, and selection provenance. Include reliable source-scoped subject grouping for downstream partition checks; do not merge patients by name or an unscoped identifier. Keep credentials out of the manifest. Omitting names or using opaque subject keys does not deidentify the underlying data or prove the manifest safe to share.
3. **Consume it outside Store.** Provide a runnable EASI JS example with bounded streaming downloads, integrity verification, and explicit missing/changed-object outcomes. Authentication stays separate. Training frameworks can consume verified local data through their own loaders; format conversion and image/annotation mapping require an explicit, tested recipe.

A snapshot freezes the selection description, not archive retention. Later imports must not silently join it. If an original is removed or unavailable, the consumer must report that fact rather than substitute the current contents of a study or series. Existing removal and access controls continue to apply.

The first slice should not generate automatic training/validation/test assignments. It should retain the grouping needed for a separate, documented patient-level partition check. Reliable cross-source patient linkage, established external test sets, and task-specific sampling need deliberate dataset design.

Acceptance criteria for a future implementation include stable membership after new imports, detection of removed or changed originals, credential-free manifests, bounded resource use, preserved originals, and a reproducible synthetic consumer test. Technical metadata warnings and visual review must remain distinct from complete image-quality, annotation-quality, privacy, or clinical validation.

## Priorities after the current interoperability work

| Backlog area | Recommended boundary |
| --- | --- |
| Labels and bulk operations | Start with selections and snapshot manifests. Add persistent collections, review states, and bulk actions when users demonstrate the need. Store annotation references and versions explicitly if annotation workflows are later added. |
| Anonymization and tag modification | Document an external deidentification workflow first. General tag correction and internal deidentified export remain separate future features. TCIA combines profiles with additional curation/review and warns that a script alone does not ensure PHI removal. DICOM separately defines options for pixels, recognizable features, graphics, structured content, and descriptors. [TCIA process](https://www.cancerimagingarchive.net/submission-and-de-identification-overview/), [DICOM PS3.15 options](https://dicom.nema.org/medical/dicom/current/output/chtml/part15/sect_E.3.html) |
| Automation and migration | Prefer an explicit manifest consumer and existing restartable transfers before a general scheduler, routing engine, or broad legacy migration tool. Preserve counts, provenance, and byte-verification boundaries. |
| Compatibility | Treat independent client testing as a release gate. Exercise authentication, compressed originals, multiframe and non-image objects within declared profiles. Preservation of an annotation object does not imply that Store or View interprets or displays it. |

Full annotation workbenches, automatic model execution, agent orchestration, marketplaces, and broad infrastructure changes are outside this proposed first slice. The aim is a dependable connection between a selected archive dataset and the developer's existing research tools.
