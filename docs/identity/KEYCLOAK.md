# Keycloak setup

This recipe connects one Keycloak realm to EASI Store's 0.6.0 OIDC preview. Complete the [shared preparation and qualification steps](GENERIC_OIDC.md) first. Administrative labels may vary by Keycloak version. This is a deployment recipe, not a claim that a particular live Keycloak installation has passed qualification.

## Create a confidential code-flow client

In the intended realm, create an **OpenID Connect** client, for example `easi-store`:

| Setting | Value |
| --- | --- |
| Client authentication | **On** |
| Standard flow | **On** |
| PKCE method | **S256** |
| Valid redirect URIs | Only `https://store.example.org/api/v1/auth/oidc/callback`, using your actual origin |
| Implicit flow / Direct access grants / Service accounts | Not required for Store browser sign-in |

Keep the client confidential and retrieve its secret from **Credentials**. Confirm the client/realm ID-token signature algorithm is **RS256**. [Keycloak client configuration](https://www.keycloak.org/docs/latest/server_admin/#_oidc_clients)

Use **Client Id and Secret** authentication accepting `client_secret_basic`. Recent Keycloak versions can restrict a client to Basic or POST; a POST-only registration does not match Store. Do not confuse this setting with how Keycloak authenticates to an upstream identity broker. [Keycloak client-secret method changes](https://www.keycloak.org/docs/26.7.5/upgrading/index.html#client-secret-authentication-method)

The usual issuer is the realm URL, for example `https://identity.example.org/realms/research`. Discover it at that URL plus `/.well-known/openid-configuration`, and copy its exact `issuer` value into Store. If your deployment uses an extra context path, include that path. Store's issuer is not the token endpoint. [Keycloak OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers#available-endpoints)

## Emit realm groups as one ID-token claim

Create dedicated groups such as `/easi-store/readers`, `/easi-store/curators`, and `/easi-store/operators`, then assign the intended users.

Open the client, select **Client scopes**, then its **Dedicated scope and mappers for this client** entry. Under **Mappers**, choose **Configure a new mapper** / **Add mapper → By configuration → Group Membership**. Set:

| Setting | Value |
| --- | --- |
| Name | `easi-store-groups` |
| Token Claim Name | `groups` |
| Full group path | **On** |
| Add to ID token | **On** |

Attach the mapper to the dedicated scope or a **default** client scope so it runs without an extra requested scope. Store requests only `openid profile`. A mapper attached solely to an optional `groups` scope will not run unless that scope is requested, which this Store profile does not do. [Keycloak client scopes](https://www.keycloak.org/docs/latest/server_admin/#_client_scopes)

The group mapper emits full paths when enabled; Store mapping keys must therefore include the leading slash and all path components. Use the regular **Group Membership** mapper, with the simple top-level claim name `groups`. [Keycloak mapper properties](https://www.keycloak.org/admin-api/protocol-mappers#group-membership)

Store does not traverse Keycloak's nested `realm_access.roles` or `resource_access` claims. A Keycloak realm/client role named `administrator` does not automatically become a Store administrator. Grant access through reviewed group mappings or exact subject mappings, keeping the emitted group array within Store's 200-group bound.

## Configure Store

Replace the realm origin, secret and group paths with your reviewed settings:

```json
{
  "mode": "hybrid",
  "oidc": {
    "issuer": "https://identity.example.org/realms/research",
    "clientId": "easi-store",
    "clientSecret": "REPLACE_WITH_PRIVATE_CLIENT_SECRET",
    "callbackUrl": "https://store.example.org/api/v1/auth/oidc/callback",
    "label": "Organization Keycloak sign-in",
    "groupsClaim": "groups",
    "subjectRoles": {},
    "groupRoles": {
      "/easi-store/readers": "reader",
      "/easi-store/curators": "contributor",
      "/easi-store/operators": "administrator"
    }
  }
}
```

Protect the file and start/restart Store using the [shared instructions](GENERIC_OIDC.md#write-the-private-configuration). Use HTTPS for both the realm and public Store endpoint; the loopback development exception is not a substitute for an organization's TLS deployment.

## Verify the deployment

Run the [shared qualification checklist](GENERIC_OIDC.md#qualify-the-complete-flow). Use Keycloak's client-scope evaluation tooling to confirm `groups` appears in the generated **ID token**, with full paths and the intended default scopes; then test the real Store-started code flow. Check readers, contributors, unmapped users and multiple-group membership. The highest explicit Store grant wins.

Realm recreation, a different issuer or changed subject-identifier policy can change identity continuity; requalify mappings rather than matching users by email. Store sign-out ends its local session and does not implement Keycloak back-channel logout. Existing sessions require fresh sign-in/restart to evaluate new claims, and Store API credentials require their own revocation/expiry.

Keycloak documentation was reviewed on 2026-10-28. Record the installed Keycloak version and actual HTTPS/realm qualification separately.
