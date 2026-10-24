# Local operations

## Data directory and lifecycle

One archive directory contains the catalog, object files, ingest/recovery state, and local authentication/configuration state. Treat it as one unit. Keep it on a reliable local disk and grant access only to the Store account. Do not rename or manually edit object files, SQLite files, journals, or lock files while the service is active.

Only one Store process may write an archive directory. Start a separate archive with a separate directory and port when testing another build. Never share one SQLite WAL directory over NFS or between replicas.

The CLI binds to `127.0.0.1:8048` by default. Stop it with Control-C. Docker forwards shutdown through Compose's init process and allows 30 seconds for graceful exit:

```sh
docker compose stop
```

Closing a laptop, killing the process, or losing power can interrupt an import. Recovery reconciles staging/object/catalog state on startup. A failed or interrupted request must be retried; the client must not assume a study was accepted merely because some bytes were sent. Identical reimports are safe to retry.

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

Transfer jobs and peer configuration are included in a full archive backup. A restored archive can resume unfinished transfers to its recorded peers. Before starting a restored copy on another host, review which transfers may resume and keep it network-isolated if their execution would be inappropriate. Do not run the original and restored copy concurrently against the same destinations without an operator decision.

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

The preview is a single-host development/research foundation. Publishing its HTTP port to a LAN or the internet is a distinct deployment task. TLS, reverse-proxy trust, backup/restore drills, retention, OIDC/RBAC/service credentials, storage capacity/quotas, audit policy, and concurrent workload qualification have explicit backlog items. An administrator account and a healthcheck alone do not establish production readiness.

No analytics or external model service is built into this product. The separately embedded viewer uses the same-origin server connection to retrieve the images selected by the user. Importing transfers data to the configured Store server; it is not local-only file viewing.
