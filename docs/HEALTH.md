# Archive health and storage protection

Open **Administration → Archive health** as an administrator. This separates
process responsiveness, current intake readiness and an explicitly requested
integrity review. A green process health response is not a certificate that all
originals have been checked or that a backup can be restored.

## Capacity and intake

The initial settings are a **256 MiB reserve**, **1 GiB warning threshold** and
**8 concurrent imports**. Administrators can change them with revision protection;
the private `health-settings.json` persists in the archive and its full backup.
The warning threshold must be at least the reserve. A zero reserve is allowed,
but does not disable the per-import safety headroom.

Store checks the filesystem's bytes available to its service account, including
before each bounded spool write. Concurrent writes share the capacity check and
admission queue. An additional 8 MiB budget per active import allows room for
metadata, the recovery journal and catalog work; an idle archive needs that
minimum headroom to report ready. The intake limit applies through the central
archive path to file/HTTP/STOW and DIMSE receiving. Large instances do not reserve
the entire maximum-instance limit before their first byte arrives.

Low capacity rejects an import with HTTP **507**; unavailable capacity or a full
intake queue returns **503**. DIMSE receiving returns a failure instead of a
successful storage acknowledgment. An in-flight import can fail if capacity
changes, so clients must inspect its final outcome. Existing storage/recovery
rules preserve already acknowledged originals and reject UID conflicts.

The reserve is a safeguard, not an operating-system quota or a disk reservation
against unrelated processes. Keep other applications from exhausting the same
filesystem. At complete exhaustion, catalog/audit writes can fail and the
service may need capacity restored and a restart; do not repeatedly retry writes
or manually remove archive objects. Free unrelated space or expand the volume,
then inspect readiness and recovery before resuming work.

## Integrity review

**Verify original hashes** checks indexed sizes/SHA-256 hashes and walks the
object directory. **Check inventory only** checks paths, existence and sizes
without reading every original's contents; it does not establish byte integrity.
Both run the catalog's SQLite quick check. The interface reports missing,
corrupted, unreferenced, unsafe and unreadable entries using opaque identifiers.
It never repairs originals, deletes unreferenced files or changes patient data.

Only one review runs at a time. It uses a read lease to prevent study removal,
bounded streaming reads and catalog pages, and checks current references when
imports overlap the review. This is a review of an evolving archive, not an
immutable whole-filesystem snapshot. For a quiet, reproducible audit, pause
imports and transfers first.

The first-release bounds are 100,000 indexed records, 100,000 filesystem entries,
30 minutes and 1,000 detailed findings. Counts continue after the finding display
fills; a work/time bound stops the review with an explicit incomplete failure.
Cancellation also preserves partial results. Neither outcome is a clean scan.
The latest completed/partial report persists privately in `health-audit.json`;
a persisted running review becomes **interrupted** after restart. A cached
SQLite result is refreshed at startup and during a review, not on every request.

## Health endpoints and offline verification

| Endpoint | Meaning | Access |
| --- | --- | --- |
| `GET /api/health` | HTTP process responds; 200 does not establish archive integrity | Minimal public response |
| `GET /api/ready` | Current storage/catalog/recovery checks permit intake; 200 or 503 | Minimal public boolean/version |
| `GET /api/v1/health` | Capacity, settings, cached catalog check and latest review | Administrator |
| `PUT /api/v1/health/settings` | Reviewed settings plus current revision | Administrator |
| `POST /api/v1/health/audits` | Start `{"verifyHashes":true}` or inventory-only `false` | Administrator |
| `GET /api/v1/health/audits/{id}` | Latest named bounded report | Administrator |
| `DELETE /api/v1/health/audits/{id}` | Cancel that review; originals remain unchanged | Administrator |

For an offline review, stop Store and use the same runtime that owns the archive:

```sh
node src/cli.js verify --data-dir /absolute/path/to/archive \
  --output /absolute/path/to/new-private-report.json
```

The command takes the archive's exclusive lock, refuses an existing report file,
and requires the report outside the archive. Add `--inventory-only` to omit
original content hashing. Exit status 0 means a completed review with no reported
findings; an incomplete review or any finding returns status 1. Reports and full
backups remain private deployment assets. This command does not replace the
[backup/restore drill](OPERATIONS.md#backups).
