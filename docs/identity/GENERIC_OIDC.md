# Connect an OpenID Connect provider

This is the shared deployment and verification guide for EASI Store's 0.6.0 identity preview. Start with the [identity and role model](../IDENTITY.md), then follow the registration recipe for [Microsoft Entra ID](MICROSOFT_ENTRA.md), [Okta](OKTA.md), or [Keycloak](KEYCLOAK.md). Another provider must meet the same protocol and claim requirements.

These recipes describe settings to qualify with your identity administrator. Automated tests use a controlled, independently signing OIDC provider; they do not certify a live vendor tenant or an organization's HTTPS deployment.

## Check the supported profile

| Setting | Store 0.6.0 profile |
| --- | --- |
| Identity providers | One exact configured issuer; no automatic tenant discovery or email-based account linking |
| Browser flow | Authorization code, PKCE `S256`, state and nonce; callback uses a query response |
| Requested scopes | Exactly `openid profile`; additional scopes are not configurable |
| ID token | Signed `RS256` JWT, verified through the provider's discovered JWKS, with valid issuer/audience/expiry/nonce |
| Confidential client authentication | `client_secret_basic`; the server keeps the client secret |
| Claims used for access | Exact `sub`, plus one configured top-level string-array group claim; no UserInfo or directory/Graph lookup |
| Role assignment | Explicit `reader`, `contributor`, or `administrator` mappings; no grant for an unmapped account |

The implementation uses `openid-client` 6.8.8. The shared-secret recipes require the registered client to accept `client_secret_basic`; a provider/client restricted to `client_secret_post`, signed client assertions, certificate credentials, DPoP or mTLS needs a different implementation profile. Do not add unsupported configuration keys to work around this. A secretless registration is possible only when the provider explicitly permits public-client authentication; these organizational recipes use confidential clients.

The discovery document must describe the same issuer you configure. Supply the issuer itself, not a `.well-known` URL or authorization/token endpoint. OIDC discovery defines this issuer boundary and publishes the endpoints, signing keys and supported client methods. [OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)

## Prepare the Store endpoint

Choose a stable HTTPS origin, for example `https://store.example.org`. Register this exact callback, including its path and any non-default port:

```text
https://store.example.org/api/v1/auth/oidc/callback
```

Store is the server-side web application. The browser receives a Store session cookie; neither the client secret nor provider tokens belong in the browser application configuration. Configure the reverse proxy, hostname and TLS certificate before testing sign-in. Store and the browser must be able to reach the appropriate provider endpoints; the Store host must also reach discovery, token and JWKS endpoints over trusted HTTPS.

Create the local administrator in default `local` mode first and take a verified backup. Begin provider qualification in `hybrid`, which deliberately retains the local operator sign-in. Change to `oidc` only after the provider, mappings and offline recovery procedure work. OIDC-only mode disables local HTTP sign-in and requires the preexisting local administrator record.

## Write the private configuration

Use a JSON file outside the repository. The following placeholders are not credentials or working account mappings:

```json
{
  "mode": "hybrid",
  "oidc": {
    "issuer": "https://identity.example.org/realms/research",
    "clientId": "easi-store",
    "clientSecret": "REPLACE_WITH_PRIVATE_CLIENT_SECRET",
    "callbackUrl": "https://store.example.org/api/v1/auth/oidc/callback",
    "label": "Organization sign-in",
    "groupsClaim": "groups",
    "subjectRoles": {},
    "groupRoles": {
      "EXACT_READER_GROUP_VALUE": "reader",
      "EXACT_CURATOR_GROUP_VALUE": "contributor",
      "EXACT_OPERATOR_GROUP_VALUE": "administrator"
    }
  }
}
```

Protect it for the service account: owner-only permissions on macOS/Linux (`chmod 600 /absolute/path/private-auth.json`) or a restricted Windows ACL. Start with:

```sh
node src/cli.js start \
  --public-url https://store.example.org \
  --auth-config /absolute/path/private-auth.json
```

`EASI_STORE_AUTH_CONFIG` is an alternative file-path setting. For Docker, mount the file read-only and make it readable by Store's UID10001. Restart after changing the file. Keep the external configuration, client registration and secret rotation procedure in protected deployment backups; the archive backup does not automatically collect that external file.

`allowInsecureLoopback` is only for explicitly configured synthetic testing using literal loopback URLs. It is not an organizational network deployment setting.

## Match the claims deliberately

Use the exact group strings emitted in the **ID token**, including case, group IDs and leading slashes. Store does not parse dotted claim paths such as `realm_access.roles`; `groupsClaim` names one top-level property. The property must contain at most 200 nonempty strings, each at most 255 characters. Keep the provider's emitted groups restricted to the application as far as its configuration permits.

`subjectRoles` is an alternative or additional explicit mapping from this client's actual ID-token `sub`. An email, directory object ID, display name or local administrator username is not a substitute. Obtain claim values through your provider's approved local/admin tooling; do not send real tokens to public JWT decoder websites or add token logging to Store.

If multiple mappings match, the highest granted role wins. A reader subject mapping cannot constrain an administrator group mapping. A missing group claim supplies no group grants; an explicit subject grant may still apply. Provider app assignment and Store role assignment are separate: successful provider authentication alone does not authorize archive access.

## Qualify the complete flow

Use synthetic archive data and separate test identities before network exposure:

1. Start sign-in from Store's sign-in screen, complete the provider flow, and verify the returned Store role. A provider application tile must initiate this same Store flow; unsolicited callbacks are rejected.
2. A mapped reader can browse/view/download an original but cannot import, delete, change datasets, manage connections or administer identity. Contributors can import and curate datasets but cannot administer/delete history. Check the [exact role boundaries](../IDENTITY.md#roles-and-archive-scope).
3. An authenticated but unmapped test user is denied. A different tenant/issuer or a mismatched callback must not grant access. Check any guest and nested-group cases your organization intends to allow.
4. Verify operator sign-in/recovery, secret expiry/rotation and restart. Changing configuration requires restart; changed provider membership is evaluated on fresh sign-in. Existing Store API credentials require explicit revocation or expiry.
5. Sign out of Store and verify archive routes require authentication. Store sign-out ends its local session; it does not claim provider-wide logout, SCIM or back-channel revocation.

Record the exact Store build, provider/tenant, issuer, app registration, claim configuration, HTTPS topology and outcomes. Never include client secrets, authorization codes, cookies or tokens in that record. Native DIMSE AE/IP admission remains independent; service integrations use separate role-bound Store API credentials rather than an OIDC ID token.

## Diagnose a failed sign-in

| Symptom | Check privately |
| --- | --- |
| Provider rejects the redirect | Exact public scheme, hostname, port and callback path; registration type must be server-side web |
| Provider rejects the client | Secret **value**, expiry and `client_secret_basic` configuration; no credentials in URLs/logs |
| Organization sign-in unavailable | Issuer/discovery URL, outbound HTTPS/DNS and certificate trust on the Store host; discovery endpoints must not redirect |
| Generic callback failure | Start again from Store; check issuer, client/audience, RS256, query/code flow and browser cookie continuity |
| Provider succeeds but access is denied | Actual ID-token group claim, exact group values or this client's `sub`; a claim available only through UserInfo is insufficient |
| Membership/configuration changes appear ineffective | Restart for configuration changes; fresh sign-in for claim changes; independently revoke stale API credentials |

Store deliberately does not display raw provider error bodies or tokens. Investigate provider-side administrative logs through the organization's normal protected process.
