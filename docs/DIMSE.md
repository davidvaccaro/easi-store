# DIMSE interoperability preview — 0.2.1

Default source/portable listener: **host `127.0.0.1`, TCP port `4248`, called AE title `EASISTORE`**. DIMSE is enabled by the normal CLI startup and can be disabled with `--no-dimse` or `EASI_STORE_DIMSE=off`. Verification can respond before administrator setup. Archival storage/query/retrieval requires completed administrator setup in the authenticated profile; explicitly selected local research mode can accept local clients before setup. Docker requires explicit network listener, peer policy, and port publication for DIMSE clients outside the container.

```sh
node src/cli.js start --dimse-port 4250 --ae-title EASISTORE
```

AE titles identify applications; they are not authentication. This preview does not implement DICOM TLS or user-identity negotiation. Keep it on loopback or a deliberately trusted network. HTTP login does not cryptographically authenticate a DICOM socket peer.

## Client trust and listener binding

DIMSE does not use the Store browser session or HTTP Bearer tokens. Its called AE must match the listener. The default policy admits any valid calling AE from an actual loopback source. In **Administration → Client access → Trusted DIMSE clients**, an administrator can disable that exception and specify exact calling-AE/source-IP pairs. Both values must match for an allowed peer; an outbound saved connection does not automatically authorize inbound associations.

HTTP and DIMSE have separate bind addresses. An HTTP `--host 0.0.0.0` still leaves DIMSE on `127.0.0.1` unless `--dimse-host` is explicitly supplied. A network DIMSE listener refuses to start without a nonempty peer list. For example, provide a JSON file containing the `dimse` policy object:

```json
{
  "allowLoopback": false,
  "peers": [
    { "callingAeTitle": "RESEARCH_PACS", "address": "192.0.2.40" }
  ]
}
```

```sh
node src/cli.js start --access-profile authenticated \
  --dimse-host 0.0.0.0 --dimse-peers-file /private/config/dimse-peers.json
```

The policy is validated and persisted in the archive's `access-policy.json`. Addresses must be exact IPv4/IPv6 literals, not DNS names, CIDR ranges, or wildcards. Use the address observed at the server's socket, including any container/NAT translation. AE/IP admission is a network trust control, not encryption or cryptographic identity; use appropriate firewall, isolated networking, VPN, or separately managed transport protection for a network deployment. Native DICOM TLS remains planned.

Local research mode requires both listeners on literal loopback addresses and does not need a Store sign-in for ordinary local DIMSE use. See [ACCESS_CONTROL.md](ACCESS_CONTROL.md) for the complete policy and headless configuration. Changes affect new associations; already accepted associations remain admitted until closed, with a two-minute idle timeout. Stop/restart for immediate disconnection.

In Docker, the default DIMSE listener is private to the container and Compose does not publish it. To enable external DIMSE deliberately, mount a peer-policy file read-only, pass `--dimse-host 0.0.0.0 --dimse-peers-file /config/dimse-peers.json` alongside the image's normal startup arguments, and publish `127.0.0.1:4248:4248` or another intended interface. Configure the caller's actual observed IP rather than an unrestricted allow-any rule. Docker bridge traffic is not a loopback source; use the authenticated profile for this topology. Publishing a port alone does not change the listener or authorize a caller.

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
