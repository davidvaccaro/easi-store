# Management API preview

These endpoints belong to EASI Store, separately from `/dicomweb`. They power the browser interface and are versioned under `/api/v1`. All archive reads and writes require a signed-in session or Bearer token. This first preview has a single administrator role; granular roles are a later milestone.

## Authentication

Create the administrator using the browser. Session cookies are HTTP-only and SameSite Strict; they expire after 12 hours and on restart. Cookie-authenticated writes require `X-EASI-Store: 1`, and cross-origin writes are rejected. No cross-origin browser access is enabled by default.

For an integration token, stop Store, then run:

```sh
node src/cli.js token --label "Research importer"
```

Use the same `--data-dir` as the server if it is customized. The command prints a new credential exactly once, as an explicit local administrative action. Keep it in a secret store, outside Git and browser client bundles. Restart Store and send `Authorization: Bearer YOUR_TOKEN` on requests. Tokens persist across restarts; the preview does not yet provide token revocation UI or scoped identities.

## Endpoints

| Method | Path after `/api/v1` | Result |
| --- | --- | --- |
| GET | `/session` | Minimal public authentication/setup state |
| POST | `/setup` | First administrator, `{username,password,bootstrapToken?}`; loopback or container bootstrap token |
| POST | `/login` | `{username,password}`, sets session cookie |
| POST | `/logout` | Ends current browser session |
| GET | `/summary` | Patient/study/series/instance counts and original byte total |
| GET | `/studies?search=&limit=100&offset=0` | `{items,total}`; literal free-text search and stable pagination |
| GET | `/studies/{studyUid}/series` | `{items}` of series summaries |
| GET | `/studies/{studyUid}/series/{seriesUid}/instances` | `{items}` of instance summaries |
| POST | `/instances` | Raw `application/dicom` original bytes; `201` stored, `200` byte-identical duplicate |
| GET | `/download/{studyUid}/{seriesUid}/{sopUid}` | Original `application/dicom` attachment |
| GET | `/activity` | `{items}` of recent persisted stored/duplicate/recovered outcomes |
| GET | `/capabilities` | Exact supported preview features |
| POST | `/demo` | Imports 12 generated synthetic CT images; no external source data |

`GET /api/health` is a separate public availability check. It does not expose archive counts or identifiers. Study and series IDs in API paths are DICOM UIDs, not filesystem paths. Object paths and files are never directly served from the data directory.

Management errors have `{error:{code,message}}`. `400` indicates invalid input, `401` a missing/expired identity, `403` a disallowed origin/header/host, `409` a conflicting UID, `413` an oversized instance, `415` unsupported media, and `422` an unsupported text encoding. Check the HTTP status before consuming a response. DICOMweb has its own standard result bodies described in [DICOMWEB.md](DICOMWEB.md).

This API currently exposes no delete, patient merge, anonymization, or configuration mutation endpoint. They require their own audited workflows and tests. A separately distributed Store SDK/OpenAPI schema is planned after these initial contracts settle.
