# Local operations

## Data directory and lifecycle

One archive directory contains the catalog, object files, ingest/recovery state, and local authentication/configuration state. Treat it as one unit. Keep it on a reliable local disk and grant access only to the Store account. Do not rename or manually edit object files, SQLite files, journals, or lock files while the service is active.

Only one Store process may write an archive directory. Start a separate archive with a separate directory and port when testing another build. Never share one SQLite WAL directory over NFS or between replicas.

The CLI binds to `127.0.0.1:8048` by default. Stop it with Control-C. Docker forwards shutdown through Compose's init process and allows 30 seconds for graceful exit:

```sh
docker compose stop
```

Closing a laptop, killing the process, or losing power can interrupt an import. Recovery reconciles staging/object/catalog state on startup. A failed or interrupted request must be retried; the client must not assume a study was accepted merely because some bytes were sent. Identical reimports are safe to retry.

## Archive client access

The default **authenticated** profile requires a session cookie or API Bearer token for DICOMweb. A machine integration can use its token directly without signing into the administrator UI. Administration and `/api/v1` management operations remain authenticated in both profiles.

For a research archive on one workstation, choose **Administration → Client access → Local research → Save access settings**. A headless source/portable installation can select the same profile at startup:

```sh
node src/cli.js start --access-profile local-research
```

The choice persists in the private `access-policy.json` and is included in a full archive backup. Local DICOMweb query/retrieve/STOW clients and trusted local DIMSE clients do not need a browser session. Ordinary non-browser STOW clients do not need Store's management-specific `X-EASI-Store` header. Both listeners must bind to literal loopback addresses; the profile is rejected for network binds. Host validation and foreign browser-origin write rejection remain active. Do not forward a research listener through a public reverse proxy or tunnel.

Select **Authenticated clients → Save access settings**, or restart with `--access-profile authenticated`, to restore credential-required DICOMweb access. DICOMweb policy changes apply immediately. DIMSE uses an independent calling-AE/source-IP admission policy; updates apply to new associations. Restart when existing associations must be disconnected immediately.

HTTP and DIMSE have separate listener addresses. DIMSE remains on loopback when HTTP binds to a network interface unless `--dimse-host` is explicitly set. Network DIMSE needs an explicit allowed-peer policy as well as deliberate port publication/firewall configuration; Docker does not expose it by default. [ACCESS_CONTROL.md](ACCESS_CONTROL.md) documents the validated policy format, API, environment variables, and topology limits. These options do not supply DICOM TLS, OIDC, granular roles, or production qualification.

## Health and diagnosis

```sh
node src/cli.js doctor
curl --fail http://127.0.0.1:8048/api/health
docker compose ps
docker compose logs --tail=100 store
```

Use `node src/cli.js doctor` when invoking the CLI directly; `npm start` already selects the start command, so do not append a second command to it. A health response means the service answers requests, not that every stored object has recently been audited or restored from backup.

Inspect the in-app Activity view for import outcomes. A duplicate is distinct from a stored new instance. An instance UID conflict requires an explicit operator decision; it is not silently repaired by replacing the earlier source.

## Connected archives and transfer jobs

Connections are persistent, administrator-configured destinations. Test with synthetic data first. Search a saved connection to retrieve studies, or use a local study/series/instance **Send** action to copy originals outward. Both directions transfer data over the configured network connection; neither action changes the source files.

**Activity → Transfers** shows the latest 100 jobs. A job processes one original instance at a time; up to 100 jobs can be queued/running/canceling. A selection is limited to 100,000 instances. Remote query/profile limits still apply and may require selecting smaller series. Queued transfers continue if the browser dialog closes.

- Acknowledged sends and durably received instances are checkpointed in the same catalog as the archive.
- Running jobs resume after restart; successful checkpoints are retained. Resume is per instance, not per byte range.
- Cancel stops additional work and aborts the in-flight operation. `canceling` remains visible until it settles; an already accepted original is retained.
- Retry is explicit for failed/canceled jobs and attempts unfinished items. Three consecutive instance failures stop an attempt to avoid repeatedly hammering an unavailable peer. There is no automatic indefinite/backoff retry scheduler yet.
- Editing or removing a peer is blocked while it has active work. An old failed job cannot retry against a changed connection revision; create a new transfer to confirm the new destination.
- Remote delivery across an interrupted final ACK is **at least once**. A remote archive can have committed an object before Store records its ACK. Its duplicate policy matters on retry. Conflicting byte representations remain explicit failures.

Transfer jobs, peer configuration, and the archive access policy are included in a full archive backup. A restored archive can resume unfinished transfers to its recorded peers. Before starting a restored copy on another host, review its access profile, DIMSE callers, and which transfers may resume; keep it network-isolated if their execution would be inappropriate. A persisted local research profile refuses incompatible network listener binds. Do not run the original and restored copy concurrently against the same destinations without an operator decision.

## Remote credentials

Keep remote passwords/tokens on the Store server, outside the checkout and browser bundles. For example, privately create an owner-readable JSON file with this structure (all values below are placeholders):

```json
{
  "orthanc-local": {
    "basicUsername": "REMOTE_USERNAME",
    "basicPassword": "REMOTE_PASSWORD"
  },
  "research-archive": {
    "bearerToken": "REMOTE_BEARER_TOKEN"
  }
}
```

On macOS/Linux, give the file owner-only permissions (`chmod 600 /absolute/path/to/private-credentials.json`). The CLI rejects non-file input, files larger than 64 KiB, and POSIX files readable/writable by group or others. On Windows, restrict its ACL to the Store account; POSIX mode bits do not establish Windows access control.

```sh
node src/cli.js start \
  --credentials-file /absolute/path/to/private-credentials.json
```

`EASI_STORE_CREDENTIALS_FILE` can supply the same path without a launcher argument. In **Connections**, open **Authentication** and enter `orthanc-local` or another configured **server credential name**. The connection record keeps the name, not the secret. Secrets are loaded at startup; restart after changing the file. Keep the credential file as a separate protected deployment input; it is not copied into portable artifacts or automatically included in the archive-directory backup unless you deliberately placed it there.

Peers require HTTPS when credentials leave literal loopback/localhost. TLS verification stays enabled and redirects are rejected. URLs cannot contain credentials, query strings, or fragments; a transfer cannot override a configured destination with arbitrary headers/paths. DIMSE AE settings are separate from HTTP Basic/Bearer credentials, and this preview does not implement DICOM TLS.

For Docker, explicitly mount a protected credential file read-only at a container path and pass that path to startup; it is not bundled into the image. Ensure UID 10001 can read the mounted file while other accounts cannot. A host's `127.0.0.1` addresses that container itself from inside Docker; use deliberate container-network addressing when connecting separate containers, and use HTTPS rather than forwarding credentials in cleartext to a non-loopback host.

## Backups

The preview provides an **offline backup/restore command**. Stop Store first: the command takes the archive's exclusive lock, checkpoints the catalog, copies the archive into a new private directory, and records a file/hash manifest. It refuses an existing backup destination. Do not improvise a live SQLite-file-only backup.

```sh
node src/cli.js backup --data-dir /absolute/path/to/archive \
  --output /absolute/path/to/new-backup
```

Restore into a new directory; the original archive remains untouched. The command verifies the backup's file sizes/hashes before opening the restored catalog:

```sh
node src/cli.js restore --input /absolute/path/to/new-backup \
  --data-dir /absolute/path/to/new-restored-archive

node src/cli.js start --data-dir /absolute/path/to/new-restored-archive \
  --port 8050 --dimse-port 4250 --open
```

In a runtime bundle, replace `node` with `runtime/bin/node` on macOS/Linux or `runtime\node.exe` on Windows. A backup contains security state as well as medical data. Keep it private, and keep the source version/runtime until a restore drill has passed.

For Docker, stop the service and back up the named `easi-store_archive` volume using your normal volume backup tooling. Confirm the actual volume name with `docker volume ls`; a custom Compose project name changes it. Keep the volume when removing a container. `docker compose down --volumes` destroys it.

Test restoration into a separate directory/volume and port before relying on a backup. Check catalog counts and original instance byte hashes. Backups contain the medical data and local security state, so they need the same access controls as the live archive.

## Updates

1. Stop Store and take a verified full backup.
2. Review the new release's migration and compatibility notes.
3. Build/extract the new application outside the archive directory.
4. Start it against the intended archive and inspect health/activity/catalog counts.
5. If a schema migration occurred, do not run an older build against the migrated directory; restore the prior backup into a separate directory instead.

Never install application files inside an archive directory or replace a data directory with the contents of a portable package.

## Networked/production use

The preview is a single-host development/research foundation. Publishing its HTTP port to a LAN or the internet is a distinct deployment task. Use authenticated mode for a network HTTP listener and protect credentials in transit with an appropriately configured HTTPS reverse proxy. DIMSE needs an explicit network bind and exact calling-AE/source-IP peers, with firewall and transport protection chosen for the environment. Those controls do not provide native DICOM TLS. Reverse-proxy trust qualification, backup/restore drills, retention, OIDC/RBAC/scoped service credentials, storage capacity/quotas, audit policy, and concurrent workload qualification have explicit backlog items. An administrator account and a healthcheck alone do not establish production readiness.

No analytics or external model service is built into this product. The separately embedded viewer uses the same-origin server connection to retrieve the images selected by the user. Importing transfers data to the configured Store server; it is not local-only file viewing.

## Study export and space reclamation (0.3.0)

Open a study and choose **Export originals** for an original-file ZIP with a SHA-256 manifest. This copies the selected snapshot to the browser's download location; it does not anonymize it or replace a full archive backup. Use a ZIP64-capable extractor for large exports.

Choose **Remove study**, review counts/bytes, and type **DELETE** to remove Store's archival copies and reclaim their unreferenced object bytes. This cannot be undone in the app. Stop imports and target transfer jobs, and allow active readers/downloads to finish before retrying a busy removal. Deleting the archive copies leaves source files, exports, backups, and remote servers unchanged.

A committed removal with incomplete reclamation is reported explicitly. Restart Store to run recovery; do not manually delete its journal or restore individual object/catalog files. If recovery reports integrity/journal conflicts, retain the whole directory for repair. The v1 removal gate is conservative across archive readers; live-client traffic may require a quiet maintenance window.

0.3.0 introduces catalog schema 2. Before its first start on an existing archive, stop Store and use the old build's offline `backup` command. Original bytes are not rewritten by migration. Keep that backup and old runtime. An older build refuses schema 2; rollback restores the pre-upgrade backup to a new directory. Current restore accepts verified 0.1.0, 0.2.0, 0.2.1, and 0.3.0 backup manifests. An original-study ZIP does not include catalog/security/peer/job state and cannot serve as this rollback backup.
