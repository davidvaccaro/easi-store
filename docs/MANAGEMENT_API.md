# Management API preview — 0.2.1

These endpoints belong to EASI Store, separately from `/dicomweb`. They power the browser interface and are versioned under `/api/v1`. Management archive reads and writes require a signed-in session or Bearer token in both client access profiles. The explicit public discovery/bootstrap routes are listed below. This first preview has a single administrator role; granular roles are a later milestone.

## Authentication

Create the administrator using the browser. Session cookies are HTTP-only and SameSite Strict; they expire after 12 hours and on restart. Cookie-authenticated writes require `X-EASI-Store: 1`, and cross-origin writes are rejected. No cross-origin browser access is enabled by default.

For an integration token, stop Store, then run:

```sh
node src/cli.js token --label "Research importer"
```

Use the same `--data-dir` as the server if it is customized. The command prints a new credential exactly once, as an explicit local administrative action. Keep it in a secret store, outside Git and browser client bundles. Restart Store and send `Authorization: Bearer YOUR_TOKEN` on requests. Tokens persist across restarts; the preview does not yet provide token revocation UI or scoped identities.

The **local-research** profile changes local DICOMweb client requirements, not management authorization. A research client may query/retrieve/STOW without credentials on a loopback connection, but cannot use management import, summary, thumbnails, settings, peer configuration, or transfer jobs without an administrator session or token. DIMSE has separate calling-AE/source-IP trust rules. See [ACCESS_CONTROL.md](ACCESS_CONTROL.md).

## Endpoints

| Method | Path after `/api/v1` | Result |
| --- | --- | --- |
| GET | `/session` | Minimal public authentication/setup state |
| GET | `/access` | Minimal public client-access requirements; no patient data, credentials, or peer list |
| GET | `/access-policy` | Authenticated administrator's complete persisted client/DIMSE policy |
| PUT | `/access-policy` | Authenticated replacement of the complete validated policy; invalid updates leave the active policy unchanged |
| POST | `/setup` | First administrator, `{username,password,bootstrapToken?}`; loopback or container bootstrap token |
| POST | `/login` | `{username,password}`, sets session cookie |
| POST | `/logout` | Ends current browser session |
| GET | `/summary` | Patient/study/series/instance counts and original byte total |
| GET | `/studies?search=&limit=100&offset=0` | `{items,total}`; literal free-text search and stable pagination |
| GET | `/studies/{studyUid}/series` | `{items}` of series summaries |
| GET | `/studies/{studyUid}/series/{seriesUid}/instances` | `{items}` of instance summaries |
| GET | `/studies/{studyUid}/series/{seriesUid}/thumbnail` | Bounded representative PNG; unsupported images return a profile error |
| GET | `/studies/{studyUid}/series/{seriesUid}/instances/{sopUid}/thumbnail` | Bounded instance PNG |
| POST | `/instances` | Raw `application/dicom` original bytes; `201` stored, `200` byte-identical duplicate |
| GET | `/download/{studyUid}/{seriesUid}/{sopUid}` | Original `application/dicom` attachment |
| GET | `/activity` | `{items}` of recent persisted stored/duplicate/recovered outcomes |
| GET | `/capabilities` | Exact supported preview features |
| POST | `/demo` | Imports 12 generated synthetic CT images; no external source data |
| GET / POST | `/connections` | List configured peers / create a peer |
| PUT / DELETE | `/connections/{id}` | Replace peer configuration / remove peer; active transfers block changes |
| POST | `/connections/{id}/test` | `{}`; real QIDO or C-ECHO connection check |
| POST | `/connections/{id}/search` | `{criteria,limit?,offset?}`; bounded remote study search |
| GET / POST | `/jobs` | Latest 100 persisted transfers / queue a transfer, returning HTTP `202` |
| GET | `/jobs/{id}` | Transfer state, counts, destination name, and last message |
| POST | `/jobs/{id}/cancel` | `{}`; cancel queued/in-flight transfer |
| POST | `/jobs/{id}/retry` | `{}`; retry unfinished items of a failed/canceled transfer |

`GET /api/health` is a separate public availability check. It does not expose archive counts or identifiers. Study and series IDs in API paths are DICOM UIDs, not filesystem paths. Object paths and files are never directly served from the data directory.

Management errors have `{error:{code,message}}`. `400` indicates invalid input, `401` a missing/expired identity, `403` a disallowed origin/header/host, `409` a conflicting UID, `413` an oversized instance, `415` unsupported media, and `422` an unsupported text encoding. Check the HTTP status before consuming a response. DICOMweb has its own standard result bodies described in [DICOMWEB.md](DICOMWEB.md).

## Client access policy

`GET /access-policy` returns a versioned policy, and `PUT /access-policy` replaces the complete object:

```json
{
  "version": 1,
  "profile": "authenticated",
  "dimse": {
    "allowLoopback": true,
    "peers": []
  }
}
```

`profile` is `authenticated` or `local-research`. Each optional peer is `{ "callingAeTitle": "RESEARCH_PACS", "address": "192.0.2.40" }`; both exact values must match the incoming association. The saved policy is included in archive backups. Research mode requires literal loopback HTTP and DIMSE listeners. A network DIMSE listener requires a nonempty peer list; `allowLoopback: false` also subjects local clients to the explicit list. Host/Origin checks and session mutation headers apply to policy updates normally. [The access guide](ACCESS_CONTROL.md) details validation, admission timing, and CLI equivalents.

`GET /access` reports only `profile`, `dicomwebAuthenticationRequired`, `administratorAuthenticationRequired`, and `dimseSecurity`. It does not grant access or return the complete policy. The `dicomwebAuthenticationRequired` value reflects the current request's actual socket; forwarded address headers are ignored.

## Connections and transfers

A DICOMweb peer is `{name,type:"dicomweb",baseUrl,credentialId?,timeoutMs?}`. Its URL must be HTTP(S), without URL credentials, query, or fragment. A DIMSE peer is `{name,type:"dimse",host,port,calledAeTitle,callingAeTitle?,timeoutMs?}`. Timeout defaults to 30 seconds and is limited to 1–300 seconds. `credentialId` names a private server configuration entry; no credentials or arbitrary headers are returned to the browser. See [OPERATIONS.md](OPERATIONS.md#remote-credentials).

Remote search criteria accept `PatientName`, `PatientID`, `IssuerOfPatientID`, `PatientBirthDate`, `StudyDate`, `StudyDescription`, `AccessionNumber`, `ModalitiesInStudy`, and `StudyInstanceUID`. Limit is 1–1,000; the UI requests 100. DICOMweb supports offset pagination; DIMSE searches require refined criteria rather than offset pagination. The return value is `{items,hasMore,offset}`, with normalized study summaries. Search responses are bounded to 4 MiB.

Queue a transfer with these identity-only selectors:

```json
{
  "connectionId": "CONFIGURED-CONNECTION-UUID",
  "direction": "send",
  "selection": {
    "studyUid": "STUDY_UID",
    "seriesUid": "OPTIONAL_SERIES_UID",
    "sopUid": "OPTIONAL_SOP_INSTANCE_UID"
  }
}
```

Omit optional keys entirely when selecting the whole study/series, and replace placeholders with valid DICOM UIDs. `sopUid` also requires `seriesUid`. `direction` is `send` or `retrieve`; both configured protocols are supported. A payload cannot override the configured address, headers, credentials, or filesystem path. The selected destination revision is recorded; changing it prevents retrying an old transfer against a silently different peer.

Job states are `queued`, `running`, `canceling`, `completed`, `failed`, and `canceled`. `total`, `completed`, and `failed` count instances, not bytes. Acknowledged/durably received instances are checkpointed; retry keeps successful checkpoints. Restart resumes interrupted running jobs and retains canceled intent. Jobs do not automatically retry forever: three consecutive instance failures stop the attempt, leaving unfinished items available for manual retry. Management `202` means a job was queued; **STOW `202` has different instance-outcome semantics**.

## Thumbnail profile and remaining work

Thumbnails are authenticated management PNGs, not standard DICOMweb rendered endpoints. Supported inputs are native 8/16-bit monochrome, native 8-bit RGB/YBR, and supported 8-bit baseline JPEG grayscale/YBR. Work is bounded to two rendering workers, 32 MiB input frames, and a ten-second rendering timeout. Unsupported objects retain their library icon and remain archived; lack of a thumbnail is not archival failure.

This API exposes no archived-object delete, patient merge, or anonymization endpoint. Those require audited workflows and tests. A separately distributed Store SDK/OpenAPI schema is planned after these contracts settle; the embedded viewer is independently documented through EASI View's SDK.
