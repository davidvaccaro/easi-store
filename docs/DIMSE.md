# DIMSE interoperability preview — 0.2.0

Default listener: **host `127.0.0.1`, TCP port `4248`, called AE title `EASISTORE`**. DIMSE is enabled by the normal CLI startup and can be disabled with `--no-dimse` or `EASI_STORE_DIMSE=off`. Verification can respond before setup; archival storage/query/retrieval requires administrator setup to be complete. Docker publishes its port on host loopback by default.

```sh
node src/cli.js start --dimse-port 4250 --ae-title EASISTORE
```

AE titles identify applications; they are not authentication. This preview does not implement DICOM TLS or user-identity negotiation. Keep it on loopback or a deliberately trusted network. HTTP login does not cryptographically authenticate a DICOM socket peer.

## Implemented roles

| Operation | EASI Store as SCP (responder) | EASI Store as SCU (requester) |
| --- | --- | --- |
| C-ECHO | Verification response | Connection test |
| C-STORE | Durable storage receive | Streamed queued sends and C-MOVE delivery |
| C-FIND | Study Root and Patient Root query | Configured remote study searches; hierarchical series/image enumeration for transfers |
| C-GET | Study Root and Patient Root retrieval; Storage SCU sub-operations on the same association | Queued durable retrieval through configured peers |
| C-MOVE | Study Root and Patient Root retrieval; Storage SCU sub-operations to a configured destination | No remote C-MOVE initiation UI/job in this release; use C-GET retrieval |
| Worklist / MPPS / Storage Commitment | Planned | Planned |

The SCP supports PATIENT (Patient Root), STUDY, SERIES, and IMAGE levels. Retrieval requires unique hierarchy keys: Patient ID for patient-level retrieval; Study UID for study; Study+Series UIDs for series; Study+Series+SOP Instance UIDs for image. Ambiguous patient-level retrieval spanning source/issuer identity namespaces is rejected; retrieve explicit study UIDs instead. No relational-query extended negotiation is claimed. Outgoing whole-study retrieval first finds series, then queries images with their parent Study+Series UIDs.

C-FIND returns requested recognized attributes, level/character-set information, retrieve AE, and availability. Supported indexed matching covers patient name/ID/issuer, study/series/image UIDs, dates, accession, descriptions, modality/modalities in study, and recognized scalar indexed fields. Basic wildcard, date-range, UID-list, and case behavior are implementation-specific documented preview behavior, not all optional DICOM matching semantics. Query identifiers use Implicit or Explicit VR Little Endian. ASCII/default, UTF-8, and ISO_IR 100 query text are supported. Unsupported optional keys can produce a pending warning; malformed identifiers produce a failure rather than a fabricated match.

## Durable storage and representations

C-STORE success is sent only after the original dataset is written and the catalog committed. The receiving path is streamed and bounded by the archive's default 512 MiB instance limit. C-GET SCU receiving follows the same durability rule; it does not use an acknowledge-before-persistence memory buffer. A C-GET client must negotiate Storage SCP role selection. C-GET serving requires the requesting peer's compatible Storage SCP roles and exact stored transfer syntax.

Storage negotiation supports native Implicit VR Little Endian, Explicit VR Little Endian, Explicit VR Big Endian, RLE, JPEG baseline/extended/lossless, JPEG-LS lossless/near-lossless, and JPEG 2000 lossless/lossy syntax UIDs in the current runtime profile. The service preserves the negotiated encoding; it does not silently decompress or transcode to make a rejected context succeed. Viewer display and selected-frame support have narrower, independent profiles.

DIMSE does not transmit a Part 10 preamble/File Meta Information header. Store generates that wrapper around the received dataset. Dataset bytes/encoding are preserved, but byte-identical equality with a sender's original complete `.dcm` file is not guaranteed. Existing UID/byte conflicts are still rejected; the preview does not maintain alternate representations automatically.

## Configure peers and C-MOVE destinations

In **Connections → Add connection**, select DIMSE and set its name, host, port, called AE, and this Store's calling AE. **Test** sends C-ECHO. The remote archive may require an allowlist entry for that calling AE and this server's address.

To permit C-MOVE delivery, configure its destination as a DIMSE connection whose **called AE title exactly matches the requested Move Destination**. Exactly one configured peer must match. Unknown or ambiguous AE titles fail; a remote request cannot supply an arbitrary destination host/port. Store sends each original to that configured host/port using C-STORE. No forwarding rule or automatic routing is implied.

For incoming queued retrieval, select the remote peer, search for studies, and choose **Retrieve study**. Store uses C-GET, persists each instance before its C-STORE acknowledgment, and records per-instance job progress in **Activity → Transfers**. The source must return instance and SOP Class UIDs during enumeration and support compatible storage-role negotiation. A peer that only supports C-MOVE retrieval needs a later outbound C-MOVE integration.

## Bounds, cancellation, and status

The default SCP allows eight simultaneous associations and bounds a query or retrieval to 10,000 results/instances. Pending query/retrieve messages, success/warning/failure/cancel status, completed/failed/warning/remaining counts, and failed-instance lists are implemented. C-CANCEL is honored while an operation is active; an already durably accepted instance is retained. Service limits or incompatible presentation contexts produce explicit non-success statuses.

Transfer jobs are serialized, checkpoint each acknowledged instance, and support restart, cancellation, and manual retry. Cancellation remains `canceling` until the in-flight network/persistence operation settles; connection edits are blocked during that interval. Delivery after power loss is at least once: the final remote ACK can be lost after remote persistence, requiring a duplicate-safe retry. See [OPERATIONS.md](OPERATIONS.md) for job and credential handling, and [VALIDATION.md](VALIDATION.md) for evidence associated with the tested candidate.
