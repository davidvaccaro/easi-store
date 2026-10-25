# Viewing, exporting, and removing studies

These workflows are available in the 0.3.0 preview. They use the management administrator session; local research DICOMweb access does not grant permission to export or remove archival copies through management APIs.

## Open a large series

Open a study in the Library, then choose its series or an individual instance. EASI View retrieves series metadata first and loads original instances as needed for display. Navigation does not require downloading the entire encoded series first. Instance buttons target the exact SOP Instance UID, including the first frame of a multiframe object. Closing/replacing the viewer cancels pending loads.

The SDK's supported SOP/codec profiles, metadata limits, per-object limits and decoded-cache budgets remain in force. A very large individual multiframe object can still exceed a budget; on-demand original-instance loading is not frame-range streaming for every syntax. Background metadata extraction and thumbnails have their own bounded workers/caches. Store's archival acceptance is independent of viewer display support.

## Export original files

Choose **Export originals**. The browser downloads a ZIP containing:

- `DICOM/{study UID}/{series UID}/{SOP Instance UID}.dcm`: unchanged archived Part 10 originals.
- `manifest.json`: product/version/time, snapshot scope, UID hierarchy, byte sizes, transfer syntaxes, and SHA-256 for each file.
- `README.txt`: verification and privacy notes.

The snapshot includes instances cataloged when export starts; later imports are excluded. Store streams one original at a time per export, verifies its size/hash against the catalog, and honors download backpressure. The browser handles disk storage and download progress; the app reports that a download was requested, not that it has completed. Closing a viewer does not cancel the browser's separate download. Cancel the download in your browser if needed.

A missing/corrupted original aborts the download. Use only a completed ZIP with a valid central directory; verify extracted files against `manifest.json`. An interrupted download is not a valid integrity copy. ZIP64 is used automatically when classic ZIP limits are exceeded; choose a compatible extraction tool.

**This is an original export, not anonymization.** Patient identifiers, private attributes, overlays, and burned-in pixels can remain. UID-only filenames do not de-identify medical images. No DICOMDIR is generated. The ZIP excludes archive accounts, configuration, SQLite history, and transfers; use the offline full-backup command for disaster recovery or rollback.

Default export limits are two simultaneous downloads, 100,000 instances, 1 TiB original bytes, a 64 MiB manifest, and one hour per export. Over-limit exports fail before starting their body. Retry a busy export after another finishes.

## Remove archival copies

Choose **Remove study**, review the series/instance counts and stored/reclaimable bytes, then type **DELETE** exactly. Cancel leaves the study unchanged. If new instances arrive after the preview, removal is rejected and a fresh preview/confirmation is required.

Successful removal deletes the selected study from Store and reclaims original objects that no remaining catalog entry references. It never deletes the source folder, remote archive, earlier exports, or backups. It cannot be undone without restoring a backup or reimporting available originals.

An active import, archive reader/download, or queued/running/canceling transfer of the selected study blocks removal. Wait for completion or cancel the relevant work before trying again. The first implementation conservatively excludes readers archive-wide; it may require a quiet interval on a busy archive. New archive readers/imports/transfers are gated while removal crosses its durable boundary.

Removal records counts in Activity. Store journals the intended snapshot before committing catalog removal and a deletion marker together. Original integrity is checked before reclamation. If the process stops before commit, restart retains the original study. If it stops after commit, restart finishes reclamation without reintroducing deleted catalog rows. A `reclamationPending` result means deletion committed but recovery must finish; restart Store and retain its journals. Corrupt or conflicting recovery state fails closed for operator review rather than silently removing uncertain files.

## Upgrade and rollback

0.3.0 migrates schema 1 to schema 2 without rewriting original images. Stop the old service and take a verified offline backup **with the old build** before starting the new one. Retain the prior runtime/source. An old build refuses the upgraded catalog; restore the pre-upgrade backup into a separate directory for rollback. A study ZIP is not a full archive backup. See [OPERATIONS.md](OPERATIONS.md#backups).
