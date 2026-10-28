# Installation and packaging — 1.0.0-rc.1

Download versioned runtime bundles from [the GitHub release](https://github.com/davidvaccaro/easi-store/releases/tag/v1.0.0-rc.1). They include the application, locked runtime dependencies, a verified Node runtime, licenses, SECURITY.md and `SBOM.cdx.json`. Unused bundled npm/npx/corepack tools are omitted; normal startup needs no package manager. Compare the published checksums before extracting.

The first preview offers three installation paths. They all run the same server and use a separate persistent archive directory.

| Path | What the user needs | First action |
| --- | --- | --- |
| Docker Compose | Docker Engine/Desktop + Compose | `docker compose up --build -d` |
| Source launcher | Node.js 24, npm, source checkout | Open the platform launcher in `scripts/` |
| Portable runtime bundle | Extract the correct OS/CPU package | Open `Start EASI Store` |

A portable package is not a signed operating-system installer. The preview includes an actual portable packaging pipeline; macOS notarization, Windows signing/MSI, Linux desktop package integration, and managed-service installation are separate qualification work. Only report a platform as tested after its native smoke test has run.

## Docker

```sh
docker compose up --build -d
```

Compose publishes HTTP on **127.0.0.1:8048**, uses a persistent named volume, runs the server as a non-root user, and enables a minimal healthcheck. HTTP binds container interfaces for port forwarding; DIMSE stays on container loopback and is not published by default. To enable network DIMSE, configure its exact calling-AE/IP trust policy, explicitly set `EASI_STORE_DIMSE_HOST=0.0.0.0`, and publish the desired port. See [access control](ACCESS_CONTROL.md) and [DIMSE setup](DIMSE.md). Its root filesystem is read-only; `/data` and the temporary mount are writable. On first setup, retrieve the bootstrap token with `docker compose exec store cat /data/bootstrap-token` if requested by the UI.

To build without Compose:

```sh
docker build --tag ghcr.io/davidvaccaro/easi-store:1.0.0-rc.1 .
docker volume create easi-store-archive
docker run --rm --init --name easi-store \
  --publish 127.0.0.1:8048:8048 \
  --mount source=easi-store-archive,target=/data \
  ghcr.io/davidvaccaro/easi-store:1.0.0-rc.1
```

This builds an image locally. No Docker Hub/GHCR image publication is implied. The image recipe pins the reviewed Node 24.22.1 base digest. The publication workflow checks the exact-source native/check runs, qualifies both native CPU images (including exhausted-storage recovery), scans each image and then publishes the versioned multi-platform manifest. Full scan reports retain vendor-deferred findings; fixable HIGH/CRITICAL findings block publication.

## Source launchers

- macOS: `scripts/launch-macos.command`.
- Windows: `scripts\launch-windows.cmd`.
- Linux: `sh scripts/launch-linux.sh` (or mark it executable in a file manager).

The launchers check for Node 24, install locked npm dependencies and build the UI when missing, then start the loopback service and open the browser. The first source launch needs internet access. They prefer a bundled `runtime/` when present, and use the operating system's application-data location for the archive. Set `EASI_STORE_DATA_DIR` and/or `EASI_STORE_PORT` before launching to override those choices. They never ask for administrator/root rights or install a background service.

Keep the terminal window open while using Store. Control-C stops the server. If macOS refuses to execute an unsigned downloaded script, use Terminal to inspect and run the launcher; do not globally disable Gatekeeper.

## Create a portable package

From a built checkout:

```sh
npm ci
npm run check
npm run artifact:pack -- --bundle-runtime
node scripts/package-smoke.mjs --latest
```

The current OS and CPU architecture are selected by default. The runtime is pinned to **Node 24.22.1**, the reviewed Node 24 security release for this preview. Override it only with an exact published release after reviewing its support/security status:

```sh
npm run artifact:pack -- --bundle-runtime \
  --target darwin-arm64 --node-version 24.22.1 \
  --output /absolute/path/to/release-artifacts
```

Recognized targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, and `win32-x64`. Recognition means the packager knows the official Node distribution name; it is not evidence that Store has passed native tests on all six targets. The historical **0.1.0** [native macOS, Windows, and Linux matrix passed](https://github.com/davidvaccaro/easi-store/actions/runs/40103493426) on 2026-10-24, including its 27-test suite and actual runtime-bundled launcher smoke checks. Local macOS ARM64 baseline packaging also passed. Those historical results do not certify a changed candidate. See [candidate-specific validation evidence](VALIDATION.md), and review the exact run and actual CPU architecture before publishing a candidate.

The packager:

1. Requires an existing built UI and release/legal inputs.
2. Copies an allowlist of application, built assets, documentation, and license files into a clean temporary directory.
3. Runs `npm ci --omit=dev --ignore-scripts` against the lockfile there. It never copies a developer's installed modules or local archive.
4. With `--bundle-runtime`, downloads an exact Node 24 distribution and `SHASUMS256.txt` from `https://nodejs.org/dist/vVERSION/`, verifies SHA-256 before extracting it, and retains its licenses while omitting unused npm/npx/corepack tools.
5. Adds a platform entry launcher, a file/hash inventory in `ARTIFACT.json`, and the runtime source/version/checksum when bundled.
6. Creates a `.tar.gz` for macOS/Linux or `.zip` for Windows, plus a SHA-256 sidecar. Existing artifacts are not silently replaced.

The runtime checksum is verified against the official manifest fetched over HTTPS. This preview does not claim independent verification of Node's release-signature chain. A signed release pipeline should add that trust step and artifact provenance.

The smoke check extracts a package created by this build, verifies its complete file inventory and runtime version, and runs its actual entry launcher with no system Node on `PATH`. It creates an isolated synthetic archive with 12 demo instances and an independent nested/multiframe object, checks protocol/transfer/access persistence, verifies a streamed ZIP and original SHA-256 manifest, removes only the independent study with typed confirmation, checks physical reclamation, and restarts to verify all 12 unselected originals remain. Run it only on your trusted current-platform artifact. It is not a general-purpose sandbox for untrusted downloads.

Without `--bundle-runtime`, an artifact ends in `-requires-node24`; its user must install Node 24. A runtime bundle includes production dependencies, so normal startup needs neither npm installation nor an internet connection. Source/test/build tools are not required to run it.

Cross-target packaging is refused if production dependencies contain native `.node` modules; build on the target platform instead. Current dependencies are expected to remain portable JavaScript/WebAssembly. Creating Windows zip files on another OS also needs `zip`/`unzip`; native Windows uses its installed `tar` and PowerShell archive support.

## Verify and run an artifact

Compare the downloaded archive against the publisher's independently supplied checksum, then extract it outside any archive/data directory. Choose the matching OS and architecture, and open the root **Start EASI Store** launcher. The service's data is stored in your application-data directory and survives replacing the extracted application folder.

On macOS/Linux:

```sh
shasum -a 256 easi-store-*.tar.gz
```

On Windows PowerShell:

```powershell
Get-FileHash .\easi-store-*.zip -Algorithm SHA256
```

`ARTIFACT.json` records build contents and runtime provenance. A checksum detects mismatches; it does not establish who published the artifact unless you trust the source of the expected checksum.

The manually triggered `.github/workflows/portable.yml` workflow tests, builds, and uploads candidate packages. `.github/workflows/publish-container.yml` accepts their successful exact-source run IDs and publishes only after both architecture-specific container/runtime/security gates pass. The portable workflow does not itself create a GitHub release or publish an npm package. Versioned releases attach the verified bundles/checksums; the separate container workflow publishes the images. Neither workflow signs a native installer.

## Verified Phase 2 candidate

[Native 0.2.0 CI](https://github.com/davidvaccaro/easi-store/actions/runs/40125121830)
passed on macOS ARM64, Windows x64 and Linux x64. Each candidate passed all 81
synthetic tests plus the expanded portable smoke with 13 generated instances,
metadata/frame/bulk/thumbnail retrieval, authentication, persistent peer CRUD,
queued STOW/WADO transfers and checkpoints across three launches. The bundles
include verified official Node 24.22.1. These are preview portable archives;
platform signing, notarization and native installer qualification remain future
work. See [VALIDATION.md](VALIDATION.md) for the exact source and evidence.

## 0.4.0 qualification

The [0.4.0 native matrix](https://github.com/davidvaccaro/easi-store/actions/runs/40369005639)
passed for source `f5d564a18a9c1b36318f9c45235d4a1c4774b987` on macOS ARM64,
Linux x64 and Windows x64. Each platform passed all 188 tests, packaged bundled
Node 24.22.1 and ran the real portable launcher smoke. The
[Check/Docker workflow](https://github.com/davidvaccaro/easi-store/actions/runs/40368920426)
also passed. Local macOS ARM64 packaging and Linux ARM64 container qualification
are recorded in [VALIDATION.md](VALIDATION.md), together with independent Orthanc
C-MOVE evidence. These are unsigned preview candidates, not a public release or
a claim of universal PACS/deployment compatibility.

## Dataset client files (0.5.0)

Portable artifacts and the Docker runtime include `examples/datasets`: the authenticated download route serves that exact packaged Python script. They do not install Python, MONAI, PyTorch or a GPU runtime. The core application still launches with bundled Node alone; researchers install the optional client/framework environment separately. Python cache/virtual-environment files are excluded from portable inputs.

The portable smoke now checks dataset creation/readiness, immutable manifest/header hashes, exact snapshot originals, protected tool access, availability after original removal and restart persistence. The full source check uses Python3.9+ for the independent client tests; native CI explicitly selects Python3.12. Qualified platform/candidate evidence is recorded in [VALIDATION.md](VALIDATION.md).
