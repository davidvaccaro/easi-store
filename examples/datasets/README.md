# Download a frozen dataset with Python

`download_dataset.py` uses Python 3.9+ and the standard library. It downloads the exact original DICOM members recorded in one EASI Store dataset version. It does not rerun the dataset's selection, expand series, follow references, or substitute a newer object.

Create a dataset and its frozen version in Store first. Use the dataset UUID and version number displayed there:

```sh
# Set EASI_STORE_TOKEN using your shell's secure secret workflow. Do not put the
# token in this command, the manifest, source control, or a shared notebook.
python3 examples/datasets/download_dataset.py \
  --base-url http://127.0.0.1:8048 \
  --dataset 11111111-1111-4111-8111-111111111111 \
  --version 1 \
  --output ./private-dataset-v1
```

An authorized Store API token is read from the `EASI_STORE_TOKEN` environment variable. `--token-env NAME` selects another variable. Dataset access still requires authorization when Store uses the local-research access profile. Non-loopback endpoints require HTTPS with normal certificate verification. Explicit Store base URLs may include a reverse-proxy path prefix. The client disables redirects and environment proxies so credentials cannot silently move to another endpoint.

Run the same command to resume. Completed files are trusted only after rechecking both their encoded size and SHA-256; incomplete `.partial` files restart from byte zero. Each completed original is flushed to disk and atomically renamed. The example downloads four originals concurrently by default (`--workers 1` through `16`) with a configurable socket timeout (`--timeout 1` through `120` seconds). Only that many members are scheduled at once.

The first run pins the exact received manifest bytes. Subsequent runs require identical bytes in the same output directory. To pin a digest provided independently by Store or a research collaborator, pass `--manifest-sha256` with the exact manifest body's SHA-256. A hash verifies identity and integrity; authorization and trust in the supplying archive remain necessary.

The output contains:

- `manifest.json`: the exact frozen manifest bytes.
- `originals/<member UUID>.dcm`: verified original DICOM files, including compressed and multiframe instances. Local filenames never use patient names, server paths, or remote URL text.
- `provenance.json`: the dataset/version/snapshot identifiers and manifest digest, plus completion status and the preservation profile.
- `report.json`: completion status, per-member expected digest/size, downloaded versus verified-existing counts, and safe failure codes. Missing originals, changed bytes and authentication failures produce a nonzero exit status. Review this report before using the dataset.
- `datalist.json`: produced only after every frozen member verifies successfully. It is removed at the start of a rerun so an earlier success cannot disguise a failed or interrupted attempt.

Keep the output private. Original DICOM objects can contain identifying attributes, private elements and burned-in pixels. The downloader does not anonymize anything. The output directory must be controlled by the current user; symbolic links, junctions and multiply linked files are rejected. An operating-system lock prevents simultaneous downloader processes from using that directory. Avoid other programs modifying it while a download runs.

## Datalist integration

The datalist uses MONAI's dictionary-of-paths convention. Each image record names one original DICOM instance in `image`; its `subjectId`, partition, UID hierarchy, transfer syntax, encoded byte count and SHA-256 come from the frozen manifest. Multiple members of the same subject must have the same partition. The client does not recompute or silently change the split.

A manifest partition of `train` becomes the `training` section; `validation` and `test` retain their names. Without a configured split, images go into `unassigned`. Members classified as segmentation, structured report or other are preserved separately in `dicom_objects`, without inferred `label` paths. A SEG remains a DICOM SEG, not a voxel mask.

For example, after choosing the appropriate image section:

```python
from monai.data import load_decathlon_datalist

records = load_decathlon_datalist(
    "private-dataset-v1/datalist.json",
    is_segmentation=False,
    data_list_key="training",  # or validation, test, unassigned
)
```

This optional integration requires MONAI separately; downloading does not. Configure an appropriate DICOM loader, frame handling and task-specific preprocessing before using these records. A series is not represented as a multi-channel list of files. No image decoding, spatial stacking, tensor conversion, SEG-to-mask conversion, image/label alignment, label validation or training-readiness guarantee is provided.

The path dictionary convention and `is_segmentation=False` option are documented in [MONAI's Decathlon datalist API](https://monai.readthedocs.io/en/latest/data.html#monai.data.load_decathlon_datalist). For more complex pipelines, use the exact local paths and manifest metadata as inputs to your own validated preprocessing.
