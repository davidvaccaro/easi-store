# Microsoft Entra ID setup

This recipe connects a single workforce tenant to EASI Store's 0.6.0 OIDC preview. Complete the [shared preparation and qualification steps](GENERIC_OIDC.md) first. It is configuration guidance based on Microsoft's published interfaces, not evidence of a tested live Entra deployment.

## Register a server-side application

1. In the Microsoft Entra admin center, choose the intended directory, then **Entra ID → App registrations → New registration**. Give the app a clear name and choose the single-tenant account option. Record the **Directory (tenant) ID** and **Application (client) ID**. [Microsoft app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
2. Under **Authentication**, add a **Web** redirect URI of `https://store.example.org/api/v1/auth/oidc/callback`, replacing the origin with Store's exact public origin. Store exchanges the code on its server, so use the Web platform and authorization code flow; no implicit ID-token grant is required. [Redirect registration](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri), [authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
3. Under **Certificates & secrets → Client secrets**, create a secret with a reviewed expiry. Copy its **Value**, not its secret ID, directly into the protected Store configuration. Microsoft's production guidance prefers certificate/federated credentials; Store's current preview supports shared-secret client authentication, not certificate/private-key assertions. If your IT policy requires those credentials, this profile is insufficient. [Microsoft application credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)

Use the tenant-specific issuer:

```text
https://login.microsoftonline.com/DIRECTORY_TENANT_ID/v2.0
```

Do not configure `common`, `organizations`, an authorization endpoint, or a discovery-document URL as Store's issuer. Microsoft publishes a tenant-substituted issuer, `RS256`, and `client_secret_basic` in its [public discovery metadata](https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration). Check the exact tenant's discovery document during qualification. This example uses the commercial Microsoft cloud; another cloud's issuer/endpoints require their own review.

## Emit application groups in the ID token

Create dedicated Store reader, curator and operator security groups. In the app registration, open **Token configuration → Add groups claim**. Configure the **ID token** group claim to emit group **Object IDs**, under the top-level name `groups`. Copy the selected groups' IDs into Store's mappings; do not use their display names or `sAMAccountName`. [Microsoft group-claim configuration](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims)

Where licensed and appropriate, select **Groups assigned to the application**, and assign the intended groups under the corresponding enterprise application's **Users and groups**. That option includes direct membership, not nested membership. Review app assignment requirements with the tenant administrator. [Microsoft group assignment and claim limits](https://learn.microsoft.com/en-us/security/zero-trust/develop/configure-tokens-group-claims-app-roles)

Entra omits the groups array when its token group limit is exceeded and may emit overage indicators. Store does not follow `_claim_sources` or query Microsoft Graph: absent `groups` gives no group-based role. An explicitly configured `subjectRoles` grant can still apply. Keep the emitted application group set small and test highly connected users; do not add directory-read permissions expecting Store to resolve overage. [Microsoft overage behavior](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference#groups-overage-claim)

## Configure Store

Replace every placeholder with reviewed tenant/app/group values. The UUIDs below are illustrative, not real directory objects:

```json
{
  "mode": "hybrid",
  "oidc": {
    "issuer": "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0",
    "clientId": "22222222-2222-4222-8222-222222222222",
    "clientSecret": "REPLACE_WITH_PRIVATE_SECRET_VALUE",
    "callbackUrl": "https://store.example.org/api/v1/auth/oidc/callback",
    "label": "Organization Microsoft sign-in",
    "groupsClaim": "groups",
    "subjectRoles": {},
    "groupRoles": {
      "33333333-3333-4333-8333-333333333333": "reader",
      "44444444-4444-4444-8444-444444444444": "contributor",
      "55555555-5555-4555-8555-555555555555": "administrator"
    }
  }
}
```

Protect the file and start/restart Store with the [shared command](GENERIC_OIDC.md#write-the-private-configuration). Store requests only `openid profile`; it does not call Graph, consume Entra access tokens as Store credentials, or require a Graph permission for this group-claim approach.

For individual grants, map this application's ID-token `sub`. Entra's user object ID (`oid`) and email are different values; they are not Store subject mapping keys. Keep the issuer/app registration stable when assessing identity continuity. [Microsoft ID-token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)

## Verify with your tenant administrator

Run the [shared qualification checklist](GENERIC_OIDC.md#qualify-the-complete-flow), including an unmapped user, direct versus nested groups, applicable guest users, a reader's denied import, and client-secret expiry/rotation. The highest explicitly mapped role applies if a user belongs to multiple mapped groups. Tenant sign-in/MFA/Conditional Access policies remain managed by Entra; Store does not replace them or promise immediate revocation of an already-issued Store session.

Microsoft documentation was reviewed on 2026-10-28. Record actual tenant and reverse-proxy qualification separately before claiming deployment support.
