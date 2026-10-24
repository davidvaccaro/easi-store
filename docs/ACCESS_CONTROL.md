# Client access and administrator access

EASI Store separates archive clients from the administrator interface. Choose the **local-research** profile for a workstation archive that ordinary local DICOM clients can use without a browser sign-in. Choose **authenticated** when DICOMweb clients must present credentials. The administrator interface and management API require a sign-in or bearer token in both profiles.

Existing and new archives default to **authenticated**. Enabling research access is an explicit choice. The selected policy is persisted in the archive's private `access-policy.json` and included in offline backups. Changing a profile does not reimport, copy, or modify stored DICOM objects.

| Access | authenticated | local-research |
| --- | --- | --- |
| DICOMweb QIDO, metadata, frames, bulk data, original retrieval, STOW | Valid administrator session or API bearer token | No credentials for clients connected over actual loopback sockets |
| Administrator UI and `/api/v1` management routes | Authentication required | Authentication required |
| DIMSE ECHO, STORE, FIND, GET, MOVE | Calling AE title/source IP policy | Calling AE title/source IP policy |
| HTTP and DIMSE listener addresses | Explicit configuration; network DIMSE needs configured peers | Both must be literal loopback addresses |
| DICOM TLS / external identity provider | Not implemented | Not implemented |

`GET /api/health`, `GET /api/v1/session`, and `GET /api/v1/access` expose minimal health or access information without patient data. First-run setup remains a separate protected bootstrap flow.

## Local research setup

For a source installation:

```sh
node src/cli.js start --access-profile local-research
```

This persists research access and starts the default HTTP listener at `127.0.0.1:8048` and DIMSE listener at `127.0.0.1:4248`, AE title `EASISTORE`. Subsequent starts retain the chosen profile. Standard local clients can query, retrieve, and send studies immediately, even before an administrator has been created. Create an administrator in the browser to manage studies, peers, and transfer jobs.

For the standalone local EASI View, select **Local EASI Store · DICOMweb** or **Local EASI Store · DIMSE** from its remote-storage workflow. Research access does not depend on an EASI Store browser session. The local viewer bridge remains restricted to its configured loopback target and reads only.

Local research is rejected if either listener binds to a network interface, `0.0.0.0`, `::`, or a hostname such as `localhost`. Use a literal loopback address, normally `127.0.0.1` or `::1`. An HTTP listener exposed through a container bridge normally needs authenticated mode instead. The policy uses the actual socket address; `Forwarded` and `X-Forwarded-For` cannot grant research access. Keep an unauthenticated research listener private to the workstation; do not expose it through a network tunnel or public reverse proxy.

Standard non-browser STOW clients do not need the custom `X-EASI-Store` header in research mode. Host validation remains active. Foreign browser origins cannot write to the archive, and no wildcard CORS access is enabled. Management mutations still require the normal origin checks and `X-EASI-Store: 1` header for session-based requests.

## Authenticated DICOMweb

Switch back through **Administration → Client access** or start with:

```sh
node src/cli.js start --access-profile authenticated
```

DICOMweb then requires either the existing HttpOnly administrator session or an API bearer token. A standalone integration can use a bearer token without maintaining an interactive browser sign-in. To issue one, stop the Store so the CLI can acquire the archive lock, then run:

```sh
node src/cli.js token --label "Research integration"
```

The command prints a secret once; save it in the client's private configuration, outside browser bundles or repositories. Restart the Store and send `Authorization: Bearer <token>` with client requests. The current tokens authorize archive and management operations; scoped roles and external identity are future work. Use HTTPS through a suitably configured reverse proxy for network HTTP deployment. HTTP bearer authentication does not encrypt transport.

## DIMSE trust

DIMSE does not use an HTTP administrator session. In local-research mode, Store accepts any valid calling AE title over actual loopback and rejects all remote source addresses. In authenticated mode, Store applies the saved DIMSE allowlist; by default that policy trusts actual loopback associations. The called AE title is checked in both modes. For network DIMSE, explicitly configure allowed pairs of **calling AE title and source IP address**. Matching only one part of the pair is insufficient. These are network trust controls, not cryptographic identity: AE titles are supplied by the caller, and DICOM TLS is not implemented.

The persisted policy contains:

```json
{
  "version": 1,
  "profile": "authenticated",
  "dimse": {
    "allowLoopback": false,
    "peers": [
      { "callingAeTitle": "RESEARCH_VIEW", "address": "192.0.2.40" }
    ]
  }
}
```

`allowLoopback: false` applies the explicit allowlist to local clients too in authenticated mode. Research mode temporarily permits all actual loopback clients and denies remote clients, preserving these saved authenticated-mode rules for the next switch back. Entries require exact IPv4 or IPv6 literals and exact calling AE titles; DNS names, CIDR ranges, interface zone IDs, unspecified addresses, and duplicate pairs are rejected. At most 256 peers are accepted. IPv4-mapped IPv6 addresses are normalized to their IPv4 equivalent. The source IP is the address observed at Store's socket, which may differ behind NAT or container networking.

Configure this in **Administration → Client access**, or supply a headless DIMSE policy file containing the `dimse` object:

```json
{
  "allowLoopback": false,
  "peers": [
    { "callingAeTitle": "RESEARCH_VIEW", "address": "192.0.2.40" }
  ]
}
```

```sh
node src/cli.js start --access-profile authenticated \
  --dimse-host 0.0.0.0 --dimse-peers-file /private/config/dimse-peers.json
```

The file's values are validated and persisted in the same `access-policy.json`; there is no second live allowlist. A network DIMSE listener refuses to start with an empty peer list. Opening the HTTP listener to the network does **not** automatically open DIMSE: DIMSE defaults to loopback unless `--dimse-host` is explicitly set. Set network firewall rules and transport protection appropriate to the deployment. C-MOVE destinations remain separately restricted to configured DIMSE connections; an inbound peer entry does not create a C-MOVE destination.

DICOMweb access changes take effect immediately. DIMSE trust changes apply to new associations. Already accepted associations retain their trust until closed, with a two-minute idle timeout; stop/restart the listener when immediate disconnection is required.

## Configuration API and environment

Authenticated administrators can read or replace the full policy:

- `GET /api/v1/access-policy` returns the policy object shown above.
- `PUT /api/v1/access-policy` accepts that complete object as JSON and returns the saved object. Session requests need `X-EASI-Store: 1`. Invalid policies leave the active policy unchanged.
- `GET /api/v1/access` is a public discovery response containing only `profile`, `dicomwebAuthenticationRequired`, `administratorAuthenticationRequired`, and `dimseSecurity`. It contains no peer addresses, credentials, or patient metadata. Client bridges can use it to distinguish an explicitly open local archive from an expired sign-in.

CLI options have corresponding environment variables:

| CLI option | Environment variable |
| --- | --- |
| `--access-profile` | `EASI_STORE_ACCESS_PROFILE` |
| `--host` | `EASI_STORE_HOST` |
| `--dimse-host` | `EASI_STORE_DIMSE_HOST` |
| `--dimse-peers-file` | `EASI_STORE_DIMSE_PEERS_FILE` |

Explicit CLI/environment profile and peer-policy options override the persisted values at startup and save the validated result. Without overrides, Store uses the persisted policy. If a stored research policy is incompatible with a new network bind, startup fails; explicitly choose authenticated mode to change it safely before opening the listeners.
