# EASI Store

**A local-first DICOM archive built with EASI JS, with a modern study library and an embedded EASI View.**

EASI Store is an independent server project in the EASI family. Import DICOM instances, find a patient or examination, browse its series, open an image, and exchange studies with configured DICOMweb or DIMSE archives. Original HTTP/file imports are preserved byte for byte; DIMSE preserves the transmitted dataset and creates Part 10 file metadata. The catalog is stored in SQLite and image objects live on disk.

**Status: 0.3.0 v1 workflow preview.** Query/Retrieve, connected archives, durable transfers, metadata/frames/bulk retrieval, and thumbnails are available. This milestone adds metadata-first viewing for large series, streamed original-study ZIP exports with SHA-256 manifests, and confirmed study removal with interrupted-removal recovery. It is not Orthanc feature parity or a production-qualified PACS. [Current status](docs/STATUS.md), [DICOMweb](docs/DICOMWEB.md), and [DIMSE](docs/DIMSE.md) distinguish the implemented profiles from the full standards. [The backlog](docs/BACKLOG.md) records the path to a complete product.

## Start with Docker

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine with the Compose plugin, then run from this checkout:

```sh
docker compose up --build -d
```

Open **http://127.0.0.1:8048**. Create your own administrator account; there is no default password. The first-run screen may ask for the one-time local bootstrap token. Read it from your container:

```sh
docker compose exec store cat /data/bootstrap-token
```

The published port is restricted to your machine. The named `archive` volume holds the database, original instances, and configuration. `docker compose down` stops the service without deleting that volume. Do not add `--volumes` when stopping an archive you want to keep.

```sh
docker compose logs --tail=100 store
docker compose stop
docker compose start
```

## Start from source

Use **Node.js 24** and npm. No external database or cloud account is needed.

```sh
npm ci
npm run build
npm start -- --open
```

The browser opens at http://127.0.0.1:8048. Initial setup creates your administrator account. The default archive directory is outside the checkout:

| Platform | Default archive directory |
| --- | --- |
| macOS | `~/Library/Application Support/EASI Store` |
| Windows | `%LOCALAPPDATA%\EASI Store` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/easi-store` |

To choose another directory or port:

```sh
npm start -- --data-dir /absolute/path/to/my-archive --port 8050 --open
```

The source checkout also includes launchers: double-click `scripts/launch-macos.command` or `scripts/launch-windows.cmd`; on Linux run `sh scripts/launch-linux.sh`. They prepare dependencies and build the UI on the first launch. Keep the terminal window open while using Store; Control-C shuts it down.

For a package with no Node installation step, see [portable packaging](docs/PACKAGING.md). The packager can bundle a checksum-verified official Node runtime and the locked production dependencies. Platform-specific signing and installers are tracked separately; an unsigned portable package is not a signed native installer.

## Try the complete workflow

1. Complete first-run setup and sign in.
2. Add the built-in **synthetic demo**, or import your own DICOM files. Extensionless DICOM instances are valid inputs.
3. Search the library, open a study, and inspect its series and instances.
4. Open an instance or series in EASI View. Metadata loads first; originals load as you navigate instead of downloading a whole series before the first image. Adjust the display or measure within the viewer's supported profiles and resource limits.
5. Choose **Export originals** to download original DICOM files in a streamed ZIP with an integrity manifest. Identifiers remain; this is not anonymization or a full archive backup. The browser manages download progress.
6. To reclaim space, choose **Remove study**, review the instance count and byte total, and type **DELETE**. Only Store's archival copies are removed. This is irreversible without a backup; source files and remote archives are unchanged. Active readers/imports/transfers can block removal.
7. Check Activity for import/removal outcomes. Identical reimports are idempotent; a conflicting SOP Instance UID is rejected instead of overwriting the original. Restart Store and confirm retained studies remain available.

[Study management](docs/STUDY_MANAGEMENT.md) explains lazy loading, export verification, deletion guardrails, and recovery. **Upgrade note:** 0.3.0 migrates the catalog from schema 1 to schema 2. Stop Store and take a verified full backup with the old build before upgrading. An older build cannot open the upgraded archive; rollback requires restoring that backup into a separate directory.

To exchange studies, open **Connections → Add connection**. Choose DICOMweb or DIMSE, save its address and protocol settings, and run **Test**. **Search studies → Retrieve study** copies selected remote objects into this archive. To send originals out, open a local study and choose **Send study**, **Send series**, or an individual instance's **Send** action. **Activity → Transfers** shows persisted progress, retry, and cancellation. Use generated data for an initial connection test, and confirm the configured destination is authorized before sending medical data.

**Importing into Store transfers files to the Store server.** With the default local deployment that server runs on your own machine; a remote Store receives an upload. This differs from EASI View's standalone local-only file opening. The source files remain where they were; Store saves its own archival copies in its data directory. No cloud upload or analytics is built into this preview.

Archival acceptance and viewer display support are separate. Store can preserve a DICOM object that the current EASI View preview cannot render. Keep original medical data private; use the generated demo when evaluating or reporting a bug.

## Connect applications

The DICOMweb base URL is **`http://127.0.0.1:8048/dicomweb`**. Choose the client access model in **Administration → Client access**:

- **Authenticated clients** is the default for new and existing archives. DICOMweb clients send an API Bearer token or a valid session cookie; integrations do not need an interactive browser sign-in.
- **Local research** lets local DICOMweb clients query, retrieve, and send studies without credentials. Both HTTP and DIMSE must bind to literal loopback addresses. Administration, management APIs, configured connections, and transfer jobs remain protected.

Select **Local research → Save access settings**, or start a source installation with `node src/cli.js start --access-profile local-research`. The choice persists across restarts. [Client access](docs/ACCESS_CONTROL.md) covers both profiles, headless configuration, and the security boundaries. The public health route reveals only service availability:

```sh
curl --fail http://127.0.0.1:8048/api/health
```

The DICOMweb profile includes study/series/instance QIDO searches, multipart DICOM STOW, original-instance/series/study WADO retrieval, nested DICOM JSON metadata, selected frame retrieval, and protected referenced bulk values. Native frame output is little-endian; supported compressed frames keep their original encoding. Whole-instance transcoding, XML metadata, and standard rendered resources remain planned. Use the [DICOMweb guide](docs/DICOMWEB.md) for exact transactions, authentication, limits, status behavior, and client examples.

The separate [management API](docs/MANAGEMENT_API.md) is rooted at `/api/v1`. It powers the library, imports, activity, capabilities, downloads, thumbnails, configured peers, and transfer jobs. It is not an Orthanc REST API replacement, and DICOMweb does not define Store's management operations. See [architecture](docs/ARCHITECTURE.md) for the boundaries.

The local DIMSE listener uses **AE title `EASISTORE`, port `4248`**. It responds to C-ECHO, receives C-STORE, and serves Study Root / Patient Root C-FIND, C-GET, and C-MOVE. Configured connections initiate C-ECHO, C-FIND, streamed C-STORE sends, and durable C-GET retrievals. C-STORE success follows archival persistence. C-MOVE destinations must match a unique configured DIMSE peer AE title. DIMSE uses its own calling-AE/source-IP policy, independently of HTTP sessions or Bearer tokens. It defaults to loopback; a network listener requires an explicit bind and allowed peers. AE/IP rules do not encrypt the connection. Worklists, MPPS, Storage Commitment, and DICOM TLS remain planned. See [DIMSE profiles and setup](docs/DIMSE.md), including Docker network configuration.

Remote HTTP credentials are optional, server-side configuration. Start with `--credentials-file /absolute/path/to/private-credentials.json`, then reference a named entry in the connection form. Do not put tokens in peer URLs or client bundles. [Operations](docs/OPERATIONS.md#remote-credentials) documents the file format and permissions.

## Test the independent local EASI View

Use the updated **EASI View source checkout** alongside Store; this local development integration does not change the separately published viewer SDK version.

1. Start Store on its default ports. For a local research archive, sign in at **http://127.0.0.1:8048/** once to choose **Administration → Client access → Local research → Save access settings**. Subsequent viewer use does not need the Store browser session. A headless installation can select the profile with `--access-profile local-research` instead.
2. In the independent `easi-view` checkout, run `npm ci` if needed, then `npm run dev`.
3. Open **http://127.0.0.1:5174/**. In authenticated mode, use the same browser and `127.0.0.1` for both applications so the Store HttpOnly session reaches the local bridge; a configured integration can use a private Bearer token instead. Local research does not depend on that session.
4. Choose **Open → Open Study → Remote Storage**, then **Local EASI Store · DICOMweb** or **Local EASI Store · DIMSE**. Search for a patient, select studies, and open the images.

The first source exercises QIDO/metadata/WADO requests; the second uses the viewer's server-side DIMSE gateway to perform real C-FIND/C-GET requests against port 4248. The bridge discovers Store's access profile, forwards only to the fixed loopback Store, and permits read workflows only. It honors explicit local research access and requires credentials when the Store requires them. Browsers do not open raw DIMSE sockets. STOW/C-STORE sends are exercised through Store's configured transfer jobs or a separate protocol sender, rather than by the viewer's search/open workflow.

If Store uses alternate ports, set `EASI_VIEW_STORE_HTTP_PORT` / `EASI_VIEW_STORE_DIMSE_PORT` in the viewer launch environment. `EASI_VIEW_PORT` changes its own listening port. The development bridge fixes the called/calling AEs to `EASISTORE` / `EASI_VIEW`. Custom deployment credentials and AE settings need an explicit integration; keep server secrets out of browser bundles and do not enable wildcard CORS.

## Development and validation

```sh
npm ci
npm test
npm run build
npm run check
node --test scripts/package-portable.test.mjs
npm run artifact:pack -- --bundle-runtime
```

Tests generate independent synthetic DICOM bytes. They do not require a private corpus, Orthanc installation, AWS credentials, or patient files. [Validation](docs/VALIDATION.md) records additional browser, container, and independent interoperability checks. Release artifacts include the application, EASI JS/EASI View dependencies and their notices, a file inventory, and a SHA-256 checksum. [Operations](docs/OPERATIONS.md) covers storage, shutdown, recovery, and backup precautions.

## Roadmap

The 0.3.0 milestone completes the initial large-study viewing, original ZIP export, and confirmed storage-cleanup workflows. Stable v1 preparation now focuses on exact-candidate recovery/backup/upgrade and resource qualification, independent interoperability, installation, and operational documentation. Collections, labels, DICOMDIR export, anonymization, routing, and migration remain later product work; standards expansion continues separately. PostgreSQL, S3-compatible storage, worklists, Storage Commitment, XML/rendered DICOMweb, and signed installers remain explicit planned work. They are not silently enabled by a configuration flag. The full [phased backlog](docs/BACKLOG.md) defines the release gates.

## License

Copyright © 2026 Xinonix Interactive Development, Inc. EASI Store uses the [EASI Store Community License](LICENSE), a **source-available license** with a commercial alternative. It is not an OSI-approved open-source license.

Eligible individuals, qualifying research institutions, nonprofit organizations, and organization groups with annual gross revenue **strictly below US $5 million** may use it without a license fee under the license's terms. An organization at or above that threshold needs a commercial license unless an institutional exception applies. The threshold applies to consolidated group revenue, not funding or the revenue of a single product. The full license controls eligibility and distribution; third-party components retain their own terms.

Commercial and OEM licensing: **[dvaccaro@xinonix.com](mailto:dvaccaro@xinonix.com)**. EASI JS and EASI View are independently versioned, separately licensed dependencies. See [NOTICE](NOTICE) and `licenses/`.
