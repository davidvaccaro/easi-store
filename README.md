# EASI Store

**A local-first DICOM archive built with EASI JS, with a modern study library and an embedded EASI View.**

EASI Store is an independent server project in the EASI family. Import DICOM instances, find a patient or examination, browse its series, open an image, and exchange studies with configured DICOMweb or DIMSE archives. Original HTTP/file imports are preserved byte for byte; DIMSE preserves the transmitted dataset and creates Part 10 file metadata. The catalog is stored in SQLite and image objects live on disk.

**Status: 0.2.0 Phase 2 interoperability preview.** This version adds Query/Retrieve, connected archives, durable transfer jobs, nested DICOM JSON metadata, frames/bulk retrieval, and thumbnails. It is not Orthanc feature parity or a production-qualified PACS. [Current status](docs/STATUS.md), [DICOMweb](docs/DICOMWEB.md), and [DIMSE](docs/DIMSE.md) distinguish the implemented profiles from the full standards. [The backlog](docs/BACKLOG.md) records the path to a complete product.

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
4. Open an instance in the embedded EASI View; navigate, adjust the display, or measure within the viewer's supported image profiles.
5. Check Activity to review persisted import outcomes. Reimporting an identical instance is idempotent; a conflicting instance with the same SOP Instance UID is rejected rather than overwriting the original.
6. Restart Store and confirm the study remains available.

To exchange studies, open **Connections → Add connection**. Choose DICOMweb or DIMSE, save its address and protocol settings, and run **Test**. **Search studies → Retrieve study** copies selected remote objects into this archive. To send originals out, open a local study and choose **Send study**, **Send series**, or an individual instance's **Send** action. **Activity → Transfers** shows persisted progress, retry, and cancellation. Use generated data for an initial connection test, and confirm the configured destination is authorized before sending medical data.

**Importing into Store transfers files to the Store server.** With the default local deployment that server runs on your own machine; a remote Store receives an upload. This differs from EASI View's standalone local-only file opening. The source files remain where they were; Store saves its own archival copies in its data directory. No cloud upload or analytics is built into this preview.

Archival acceptance and viewer display support are separate. Store can preserve a DICOM object that the current EASI View preview cannot render. Keep original medical data private; use the generated demo when evaluating or reporting a bug.

## Connect applications

The DICOMweb base URL is **`http://127.0.0.1:8048/dicomweb`**. Authentication is required for archive data. The public health route reveals only service availability:

```sh
curl --fail http://127.0.0.1:8048/api/health
```

The DICOMweb profile includes study/series/instance QIDO searches, multipart DICOM STOW, original-instance/series/study WADO retrieval, nested DICOM JSON metadata, selected frame retrieval, and protected referenced bulk values. Native frame output is little-endian; supported compressed frames keep their original encoding. Whole-instance transcoding, XML metadata, and standard rendered resources remain planned. Use the [DICOMweb guide](docs/DICOMWEB.md) for exact transactions, authentication, limits, status behavior, and client examples.

The separate [management API](docs/MANAGEMENT_API.md) is rooted at `/api/v1`. It powers the library, imports, activity, capabilities, downloads, thumbnails, configured peers, and transfer jobs. It is not an Orthanc REST API replacement, and DICOMweb does not define Store's management operations. See [architecture](docs/ARCHITECTURE.md) for the boundaries.

The local DIMSE listener uses **AE title `EASISTORE`, port `4248`**. It responds to C-ECHO, receives C-STORE, and serves Study Root / Patient Root C-FIND, C-GET, and C-MOVE. Configured connections initiate C-ECHO, C-FIND, streamed C-STORE sends, and durable C-GET retrievals. C-STORE success follows archival persistence. C-MOVE destinations must match a unique configured DIMSE peer AE title. Worklists, MPPS, Storage Commitment, and DICOM TLS remain planned. The Compose port is restricted to the local machine; AE titles are not authentication, and DIMSE requires a trusted network if deliberately exposed beyond loopback. See [DIMSE profiles and setup](docs/DIMSE.md).

Remote HTTP credentials are optional, server-side configuration. Start with `--credentials-file /absolute/path/to/private-credentials.json`, then reference a named entry in the connection form. Do not put tokens in peer URLs or client bundles. [Operations](docs/OPERATIONS.md#remote-credentials) documents the file format and permissions.

## Test the independent local EASI View

Use the updated **EASI View source checkout** alongside Store; this local development integration does not change the separately published viewer SDK version.

1. Start Store on its default ports and sign in at **http://127.0.0.1:8048/**.
2. In the independent `easi-view` checkout, run `npm ci` if needed, then `npm run dev`.
3. Open **http://127.0.0.1:5174/** in the same browser. Use `127.0.0.1` for both applications so the existing Store HTTP-only session can be used by the read-only bridge.
4. Choose **Open → Open Study → Remote Storage**, then **Local EASI Store · DICOMweb** or **Local EASI Store · DIMSE**. Search for a patient, select studies, and open the images.

The first source exercises QIDO/metadata/WADO requests; the second uses the viewer's server-side DIMSE gateway to perform real C-FIND/C-GET requests against port 4248. The bridge verifies the Store session, forwards only to the fixed loopback Store, and permits read workflows only. Browsers do not open raw DIMSE sockets. STOW/C-STORE sends are exercised through Store's configured transfer jobs or a separate protocol sender, rather than by the viewer's search/open workflow.

If Store uses alternate ports, set `EASI_VIEW_STORE_HTTP_PORT` / `EASI_VIEW_STORE_DIMSE_PORT` in the viewer launch environment. `EASI_VIEW_PORT` changes its own listening port. The development bridge fixes the called/calling AEs to `EASISTORE` / `EASI_VIEW`; custom deployment/authentication and AE configuration require an explicit integration rather than enabling public archive access or wildcard CORS.

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

Phase 2 establishes everyday search/retrieve/send workflows with explicit protocol and resource limits. The next product phase is collections, labels, research import/export, anonymization profiles, routing, and migration; standards expansion and production qualification continue separately. PostgreSQL, S3-compatible storage, worklists, Storage Commitment, XML/rendered DICOMweb, and signed installers remain explicit planned work. They are not silently enabled by a configuration flag. The full [phased backlog](docs/BACKLOG.md) defines the release gates.

## License

Copyright © 2026 Xinonix Interactive Development, Inc. EASI Store uses the [EASI Store Community License](LICENSE), a **source-available license** with a commercial alternative. It is not an OSI-approved open-source license.

Eligible individuals, qualifying research institutions, nonprofit organizations, and organization groups with annual gross revenue **strictly below US $5 million** may use it without a license fee under the license's terms. An organization at or above that threshold needs a commercial license unless an institutional exception applies. The threshold applies to consolidated group revenue, not funding or the revenue of a single product. The full license controls eligibility and distribution; third-party components retain their own terms.

Commercial and OEM licensing: **[dvaccaro@xinonix.com](mailto:dvaccaro@xinonix.com)**. EASI JS and EASI View are independently versioned, separately licensed dependencies. See [NOTICE](NOTICE) and `licenses/`.
