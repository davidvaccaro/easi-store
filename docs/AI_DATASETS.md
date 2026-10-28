# AI dataset workflows — 0.5.0 preview

EASI Store's **Datasets** workspace turns selected archived series into reproducible research inputs. Save a working cohort, inspect it in EASI View, freeze an immutable version, and download the exact original instances into Python tools with independent integrity verification. Optional subject-grouped partitions keep all instances in a known archived subject group together.

This is an AI **data preparation** workflow. Store does not run a model, generate clinical labels, anonymize images, convert SEG into masks, or establish clinical/training suitability. Original bytes and encodings are preserved. Store itself requires Node 24; the optional download client requires Python 3.9+ with no third-party dependencies. The optional MONAI example has its own research environment.

## Try it immediately

1. Open **Datasets → Try a synthetic cohort**. This imports 36 independently generated instances: six subjects, two examinations and one series per examination. It also creates a working dataset selecting those 12 series. The generated originals remain ordinary archived objects; removing the dataset definition does not remove them.
2. In **Selection & review**, inspect counts and technical notices. Choose **View** on a series to inspect it in the embedded EASI View. **Choose series** supports additive selections across studies; filters search the visible archive catalog, not an external clinical database.
3. Choose **Freeze version**. Leave partitioning off for an unsplit cohort, or explicitly configure a seed and train/validation/test fractions. Review the actual subject counts; proportions are approximate and small cohorts can have empty partitions.
4. In **Frozen versions**, verify availability and SHA-256, download the manifest, and download the Python consumer. The displayed command selects the exact version and pins its manifest digest.
5. Add an original to a selected series or edit the working selection, then freeze version 2. Version 1 retains its exact original membership and manifest bytes.

The normal **New dataset** path creates an empty named draft. Add a purpose, organizational labels and private review notes, then select series. These labels describe the dataset; they are not image annotations or diagnostic ground truth. Authenticated review screens can display study/series descriptions, while portable manifests omit those descriptions, names, MRNs, raw source URLs and free-text review notes.

## What a frozen version records

Each version has a UUID snapshot identifier, creation time, Store version and exact manifest SHA-256. Members record their Study/Series/SOP UIDs, SOP class and transfer syntax, encoded size, SHA-256, frame count, indexed dimensions, conservative object role, opaque subject/source references, optional partition, and a fixed authenticated original-download route. Credentials and filesystem paths are not exported.

A version freezes its selection **description**, not archive retention. New imports do not silently join it. Later study removal can make a member unavailable. The API and consumer report missing or changed members instead of substituting the current contents of a study or series. Deleting a dataset requires the current revision and typed **DELETE DATASET**; it removes its definition and version history, retaining all original DICOM objects. Existing read/import/removal guardrails continue to apply.

Subject identifiers remain stable within that dataset's versions. Grouping follows Store's existing identity rules: Patient ID plus issuer when available, otherwise the import source, with a study fallback for missing Patient IDs. Names alone never merge subjects. One person split across source namespaces or missing identifiers can still form multiple groups. Technical notices identify this limitation; reliable cross-source linkage and independent test-set design remain the researcher's responsibility.

## Explicit subject-grouped partitions

Partitioning is optional and never enabled automatically. A nonempty seed and fractions summing to 1 produce deterministic hash assignments for the saved subject references. Every selected study, series, instance and frame belonging to a known group receives the same partition. Reusing the same dataset, seed and ratios keeps existing groups' assignments stable as a later version adds subjects.

The manifest records requested fractions and actual subject counts. Assignments are approximate, not stratified sampling, exact quotas, class balancing, site balancing, or clinical identity verification. Changing the seed or ratios deliberately changes the experiment split. Inspect small/empty partitions and review unknown/source-scoped identities before relying on independence. No slice-level random split is offered.

## Technical review and availability

The fast review uses projected indexed metadata without decoding pixels or loading every complete metadata document. It reports mixed image dimensions, modalities, SOP classes or transfer syntaxes; missing/repeated Instance Numbers; missing image dimensions; and uninterpreted/non-image object roles. It also reports identity-grouping limitations.

These checks do not assess geometry, spacing, orientation, calibration, image quality, burned-in identifiers, label quality, or model suitability. A readable import or absence of metadata notices is not proof of any of those properties. SEG and SR originals can travel with the cohort, but source-reference interpretation, annotation alignment and mask conversion are separate future work.

**Verify availability & hashes** reads each frozen original and compares its encoded size and SHA-256. It supports cancellation. The lower-cost API check with `verifyHashes:false` checks catalog/file availability and size only; it does not verify content bytes. A successful check describes that moment and does not reserve originals against later deletion.

## Verified downloads

Create a named, expiring `reader` credential through **Administration → Identity** while Store is running; reader is sufficient for frozen manifest/original downloads and availability/hash checks. An administrator receives `{token,credential}` once and can revoke it later. Use contributor for imports/dataset creation or editing, and administrator only for destructive/administrative work. The offline `token` CLI remains an operator compatibility path. Dataset management stays authorized in local-research mode; that profile's anonymous exemption applies only to loopback DICOMweb. See [identity and permissions](IDENTITY.md).

Set `EASI_STORE_TOKEN` through your shell/secret manager, outside the command text, manifest and notebook. Copy the command from **Frozen versions → Run a verified download**, or use:

```sh
python3 examples/datasets/download_dataset.py \
  --base-url http://127.0.0.1:8048 \
  --dataset DATASET_UUID --version 1 \
  --manifest-sha256 EXACT_MANIFEST_SHA256 \
  --output ./private-dataset-v1
```

Replace the placeholders with that frozen version's actual values. [The consumer guide](../examples/datasets/README.md) explains all options, output layout and failures. Non-loopback endpoints require HTTPS. Redirects and environment proxies are disabled. The client downloads with bounded concurrency, streams size/hash checks, writes private partial files, flushes successful originals and atomically renames them. Repeating the same command resumes by verifying already completed files; incomplete files restart from byte zero.

The output includes the exact manifest, provenance, a machine-readable integrity report and a role-separated datalist. The datalist is published only when every frozen member verifies. Missing/corrupt objects, authentication errors, a changed manifest or inconsistent subject partitions produce a nonzero exit status. Never treat a stale earlier datalist or a partial download as a completed dataset. The output path must be controlled by the user; links/junctions and multiply linked files are rejected. On systems with temporary-directory aliases, use their canonical path.

## Optional MONAI loading

The downloader emits instance-level image path dictionaries in `datalist.json`, with subject, UID, partition and integrity metadata. SEG/SR/other members remain separate objects and never become inferred `label` masks. A DICOM series file list is not presented as a list of image channels.

The separately pinned example loads verified native images through MONAI's real DICOM reader:

For a Linux CPU-only environment, first install the pinned PyTorch CPU build
using the command in `requirements-monai.txt`; otherwise select the appropriate
PyTorch build for your platform before installing the remaining requirements.

```sh
python3 -m venv /absolute/path/to/private-monai-env
# Activate that environment using its platform's activation command.
python -m pip install -r examples/datasets/requirements-monai.txt
python examples/datasets/monai_example.py ./private-dataset-v1 \
  --partition training --limit 2
```

Use `unassigned` for a version without splits. The example rechecks the completed receipt, manifest digest, membership, paths and original hashes, then lazily loads a bounded number of native monochrome instances into CPU tensors. It does not train a model, assemble a spatial volume or convert annotations. Compressed image codecs, other photometric profiles and task-specific preprocessing need their own qualified pipeline.

An isolated real test used Python 3.12.16, MONAI 1.6.1, CPU PyTorch 2.8.0, NumPy 2.2.6 and pydicom 3.0.1. It exercised authenticated Store → independent downloader → `load_decathlon_datalist` → `Dataset` / `PydicomReader` / channel-first CPU tensors for generated native 2D and three-frame objects. Every decoded/rescaled pixel was independently verified. [Validation](VALIDATION.md) records the exact scope and candidate evidence; this does not qualify every compressed syntax, clinical object or training task.

## Preparing private data outside Store

For external sharing, first create a separate, controlled staging copy using an established deidentification workflow and a suitable DICOM PS3.15 profile. Preserve consistent subject and UID/reference mappings across related studies/annotations, record the tool/profile/version and provenance, and review metadata, private attributes, documents, overlays and pixel content as applicable. Import the resulting derivative as new data; never edit Store's hash-addressed files or catalog directly.

Opaque identifiers and omitted names do not make a manifest or its DICOM originals anonymous. Dates, UIDs and burned-in text may remain identifying. A technical hash check does not perform privacy review. TCIA documents additional curation/review beyond a script, and DICOM defines separate options for pixel data, graphics, structured content and other attributes. [TCIA process](https://www.cancerimagingarchive.net/submission-and-de-identification-overview/), [DICOM PS3.15 options](https://dicom.nema.org/medical/dicom/current/output/chtml/part15/sect_E.3.html).

## Bounds and the v1 boundary

A working selection supports up to 1,000 series and a snapshot up to 100,000 instances, subject to the 96 MiB manifest limit. The archive permits 1,000 dataset definitions, 100 versions per dataset, 500,000 frozen member records and 512 MiB of manifest bodies. Removing unused dataset definitions frees this metadata capacity. Dataset definitions/versions share the archive's durable SQLite catalog and full backup/restore boundary.

HTTP limits include four simultaneous snapshot original readers, two manifest responses and two availability checks. Encoded originals remain streamed; snapshots do not duplicate them. The Store runtime and portable launcher do not install Python, MONAI, a model service or a GPU runtime. [Management API](MANAGEMENT_API.md) documents the explicit endpoints.

For v1, this implements useful selections/organizational labels, reproducible manifests, bounded verified data access and a qualified independent consumer path. General tag correction/anonymization, routing engines, broad migration, annotation editing and model execution remain demand-led future work in [BACKLOG.md](BACKLOG.md).

The design follows documented research workflows rather than measured market demand: [IDC cohort manifests](https://learn.canceridc.dev/portal/cohort-manifests), [IDC data versioning](https://learn.canceridc.dev/data/data-versioning), [RSNA CLAIM patient-level partitions](https://rsna.github.io/claim/item-20.html), and [MONAI's dataset interfaces](https://monai.readthedocs.io/en/stable/data.html).
