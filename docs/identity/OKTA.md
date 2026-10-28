# Okta setup

This recipe uses a confidential OIDC web application and an explicit group claim for EASI Store's 0.6.0 preview. Complete the [shared preparation and qualification steps](GENERIC_OIDC.md) first. These settings follow Okta's published interfaces; a live Okta tenant has not been qualified by the automated synthetic-provider tests.

## Register the web application

In Okta's Admin Console, create an app integration with **OIDC - OpenID Connect → Web Application**. Enable the authorization code grant, use a client secret, and register the exact sign-in redirect URI `https://store.example.org/api/v1/auth/oidc/callback`. Assign only the intended users/groups. Store handles PKCE `S256` and code exchange; it does not need implicit, password or client-credentials grants for browser sign-in. [Okta web-app registration](https://developer.okta.com/docs/guides/sign-into-web-app-redirect/main/)

Record the client ID and secret privately. Ensure the app's token endpoint authentication method is **`client_secret_basic`**, which Okta documents as its default. A registration requiring private-key JWT or another authentication method does not match this Store profile. [Okta client authentication](https://developer.okta.com/docs/api/openapi/okta-oauth/guides/client-auth)

## Choose one exact issuer

| Authorization server | Example Store `issuer` |
| --- | --- |
| Org authorization server | `https://your-org.okta.com` |
| Custom authorization server named `default` | `https://your-org.okta.com/oauth2/default` |
| Another custom authorization server | `https://your-org.okta.com/oauth2/AUTHORIZATION_SERVER_ID` |

These are different security domains, not interchangeable URL spellings. Match the app's actual token issuer and discovery metadata, including a custom domain if configured. Custom authorization servers require the applicable API Access Management entitlement in production, and a new `default` server may need an access policy. [Okta authorization servers](https://developer.okta.com/docs/concepts/auth-servers/)

The following group-based recipe uses a **custom authorization server** because it can explicitly emit the claim in the ID token for this code flow. Store does not validate an Okta access token as a Store API credential; independent integrations use Store-issued API credentials.

## Put the groups in the ID token

Under **Security → API → your authorization server → Claims**, add a claim:

| Setting | Value |
| --- | --- |
| Name | `groups` |
| Include in token type | **ID Token**, then **Always** |
| Value type | **Groups** |
| Filter | A narrow app-specific allowlist, for example names matching `^easi-store-(readers\|curators\|operators)$` |
| Include in | **Any scope** |

Create/assign those groups and a policy/rule allowing the intended web app's authorization-code requests. Do not copy the vendor example's access-token-only claim setting: Store needs the ID-token claim. [Okta groups-claim guide](https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/)

The **Always** and **Any scope** settings matter: Store requests exactly `openid profile`, not `groups`, and does not fetch UserInfo. A claim available only for the `groups` scope, an access token or a UserInfo response cannot authorize a group-based Store login. [Okta ID-token claim inclusion](https://help.okta.com/en-us/Content/Topics/Security/api-config-claims.htm)

An org authorization server can support OIDC sign-in, but its groups-claim behavior must be checked for this authorization-code request; do not assume an implicit-flow example proves the claim will be in the returned ID token. If a suitable ID-token group claim cannot be configured, use explicit actual `sub` mappings or select an appropriately licensed custom authorization server. No automatic UserInfo fallback occurs.

## Configure Store

The group keys are exact emitted group names, including case. Substitute your actual issuer, app credentials and group values:

```json
{
  "mode": "hybrid",
  "oidc": {
    "issuer": "https://your-org.okta.com/oauth2/default",
    "clientId": "REPLACE_WITH_CLIENT_ID",
    "clientSecret": "REPLACE_WITH_PRIVATE_CLIENT_SECRET",
    "callbackUrl": "https://store.example.org/api/v1/auth/oidc/callback",
    "label": "Organization Okta sign-in",
    "groupsClaim": "groups",
    "subjectRoles": {},
    "groupRoles": {
      "easi-store-readers": "reader",
      "easi-store-curators": "contributor",
      "easi-store-operators": "administrator"
    }
  }
}
```

Protect the file and start/restart Store using the [shared instructions](GENERIC_OIDC.md#write-the-private-configuration). Okta documents RS256-signed ID tokens, which matches this Store profile. [Okta ID-token format](https://developer.okta.com/docs/api/openapi/okta-oauth/guides/overview#id-token-claims)

## Verify the role boundary

Run the [shared qualification checklist](GENERIC_OIDC.md#qualify-the-complete-flow). In particular, use a reader, an operator, and an assigned app user with no Store mapping. Verify the claim is present in the actual code-flow ID token using approved administrative tooling without publishing tokens. If access is denied after successful Okta sign-in, inspect issuer and claim inclusion before expanding scopes or mappings. A user matching multiple mappings receives the highest explicit role.

Okta documentation was reviewed on 2026-10-28. App assignment, MFA and account lifecycle remain Okta policies; existing Store sessions and API credentials have the separate lifetime/revocation rules in [IDENTITY.md](../IDENTITY.md).
