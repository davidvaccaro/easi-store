# Identity and permissions — 0.6.0 preview

EASI Store supports three explicit HTTP identity modes. Authentication establishes who is calling; authorization decides which operations that identity may perform. Client access policy and native DIMSE admission remain separate controls.

| Mode | Interactive sign-in | Intended setup |
| --- | --- | --- |
| `local` | Built-in local administrator | Default workstation or small shared archive |
| `hybrid` | Configured OpenID Connect provider and local administrator | Organizational sign-in with deliberately retained local administration |
| `oidc` | Configured OpenID Connect provider | Organizational sign-in; local HTTP sign-in is disabled |

The default remains `local`. There is one built-in local administrator, not a directory of local staff accounts. Organizational users can have individual OIDC identities. Service clients use separately issued Store API credentials; an identity provider's ID token is not a Store API credential.

## Roles and archive scope

| Role | Allowed operations |
| --- | --- |
| `reader` | Browse studies/series/instances, view images, retrieve/export originals, read dataset definitions/frozen manifests, download the Python consumer, and verify frozen original availability/hashes |
| `contributor` | Reader operations plus import/STOW, generated demos, and create/edit/freeze dataset definitions |
| `administrator` | Contributor operations plus study/dataset-history removal, remote connections, transfer jobs, client access settings, identity/token administration and archive/security activity |

Roles apply consistently to HTTP browser sessions and Store API credentials. A reader can download originals: this is archive-wide read access, not a view-only or per-patient restriction. Contributors can change shared dataset definitions. There is no project/tenant isolation, ownership-based dataset policy or per-study access control in this profile.

Permission names are `archive.read`, `archive.import`, `datasets.write`, `connections.manage`, `transfers.manage`, `archive.delete`, `access.manage`, `identity.manage`, and `activity.read`. The server classifies routes before processing their bodies or calling their handlers. Unrecognized management mutations are denied. Hiding a button does not provide authorization.

`local-research` permits truly anonymous DICOMweb clients only on allowed literal loopback listeners/sockets. It does not grant anonymous management access, and it does not elevate a supplied reader credential into an importer. An invalid supplied credential is rejected rather than treated as an anonymous write request. Native DIMSE retains its independent calling-AE/source-IP policy; HTTP roles and SSO do not authorize or encrypt DIMSE associations.

## Local administrator lifecycle

Create the local administrator during first-run setup. There is no shared default password. The existing bootstrap and host/origin safeguards still apply. Passwords are salted and derived with scrypt; session cookies are HttpOnly and SameSite Strict. Sessions expire and are cleared on restart.

In **Administration → Identity**, a local administrator session can change its password by providing the current and new password. Service credentials and OIDC sessions cannot change the local administrator password. A successful change requires a new local sign-in and invalidates prior local sessions and all Store API credentials. Independent OIDC sessions remain subject to their own session and mapping policy. Use a password manager; never place passwords in source code, request URLs or shared example commands.

A shared server may retain its one local administrator for operators while individual users sign in through OIDC. Sharing that administrator password among ordinary researchers defeats individual attribution; give each integration its own named, revocable API credential instead.

## API credentials

An administrator can create, list and revoke credentials while Store is running. Choose the least privileged role and a lifetime of 1–365 days. The new secret is returned once; Store persists its hash and metadata, not the plaintext secret. Lists never return the secret or its hash. Revocation takes effect for subsequent requests without restarting Store. Already-running streams or transfers are not retroactively recalled.

Keep the secret in the client application's secret store or a private environment variable. Do not put it in an OIDC configuration, dataset manifest, notebook output, URL, browser bundle or repository. The Python consumer reads a selected environment variable; a `reader` credential is sufficient to download a frozen version and verify it.

The management API is:

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/v1/auth/tokens` | Administrator-only redacted `{items}` list |
| POST | `/api/v1/auth/tokens` | `{label,role,expiresInDays}`; `201` returns `{token,credential}` once |
| DELETE | `/api/v1/auth/tokens/{id}` | Administrator-only revocation; `{revoked:true}` |
| POST | `/api/v1/auth/password` | Local administrator session only; `{currentPassword,newPassword}`; successful response requires reauthentication |
| GET | `/api/v1/identity` | Administrator-only redacted identity/configuration summary |
| GET | `/api/v1/auth/activity` | Administrator-only recent principal-attributed security actions |

Cookie mutations require `X-EASI-Store: 1` and the normal same-origin rules. Store bearer credentials do not need the cookie-specific header; foreign browser-origin mutations remain rejected. Credentials authorize only their assigned role; request bodies cannot add permissions or impersonate a different principal.

Existing pre-0.6 local administrator records and integration credentials are accepted for compatibility. Existing credentials retain administrator privilege and their legacy non-expiring status until explicitly revoked/rotated; replace them with named, expiring reader/contributor credentials where appropriate. Existing scrypt password hashes remain valid. Take a verified full backup before upgrading and preserve the old runtime for rollback.

## Configure OpenID Connect

Provider setup recipes are available for [Microsoft Entra ID](identity/MICROSOFT_ENTRA.md), [Okta](identity/OKTA.md), and [Keycloak](identity/KEYCLOAK.md). Start with the [shared OIDC profile, private configuration and qualification checklist](identity/GENERIC_OIDC.md) for another provider or deployment. These guides describe settings to qualify; they do not claim that live vendor tenants have passed qualification.

Register EASI Store as a web application with the organization's identity provider. Configure an exact HTTPS public URL and callback:

```text
https://store.example.org/api/v1/auth/oidc/callback
```

Create the local administrator in `local` mode before enabling `oidc`-only mode. Store rejects OIDC-only startup without that preexisting administrator; this establishes an explicit operator recovery boundary.

A private JSON configuration may look like:

```json
{
  "mode": "hybrid",
  "oidc": {
    "issuer": "https://identity.example.org/realms/research",
    "clientId": "easi-store",
    "clientSecret": "REPLACE_WITH_PRIVATE_SERVER_SECRET",
    "callbackUrl": "https://store.example.org/api/v1/auth/oidc/callback",
    "label": "Research organization",
    "groupsClaim": "groups",
    "subjectRoles": {
      "provider-assigned-operator-subject": "administrator"
    },
    "groupRoles": {
      "imaging-readers": "reader",
      "imaging-curators": "contributor"
    }
  }
}
```

This is a configuration example, not a real secret or a tested provider deployment. Save your actual file outside the checkout, owner-only on macOS/Linux (`chmod 600`); restrict its Windows ACL to the Store account. Do not commit it or edit `.env` files. `clientSecret` is optional only when the registered provider/client profile permits it.

Start Store with the configured public endpoint:

```sh
node src/cli.js start \
  --public-url https://store.example.org \
  --hosted \
  --access-profile authenticated \
  --auth-config /absolute/path/to/private-auth.json
```

`EASI_STORE_AUTH_CONFIG` can supply the file path instead. Restart after changing the configuration. For Docker, mount the private configuration read-only and ensure Store's UID10001 can read it. Keep HTTP behind a properly configured HTTPS reverse proxy. Native DIMSE still requires its separately configured listener and AE/IP policy.

For an organizational deployment, explicitly select authenticated client access. Sign-in mode and DICOMweb client access are separate settings: enabling SSO does not replace a previously selected `local-research` policy. Keep that research profile private to the workstation.

Only the configured issuer is trusted. Store uses validated issuer plus subject (`iss` + `sub`) as the external identity key. Email, display name and a matching local username do not link accounts or grant access. Explicit subject and group mappings contribute roles; when more than one mapping matches, the highest explicitly granted role applies. A subject mapping does not override a more privileged matching group. There is no default role for every person who can sign into the organization. Unmapped users are denied, and changing a mapping is an administrative configuration change.

The OIDC flow uses authorization code plus PKCE, state/nonce validation and RS256 provider signature/issuer/audience checks through `openid-client` 6.8.8. The confidential-client profile uses `client_secret_basic`; certificate/private-key assertions and other signing algorithms are outside this initial profile. Store requests exactly `openid profile` and reads the configured group claim from the ID token, without UserInfo or directory lookups. The temporary callback transaction cookie uses SameSite Lax for the identity-provider return; the Store session cookie remains SameSite Strict. Callback failures show a generic sign-in failure rather than exposing authorization codes, tokens or provider response bodies.

`allowInsecureLoopback` is an explicit synthetic/local-provider testing exception, not permission to use cleartext network identity endpoints. Do not enable it for an organizational deployment. Do not supply identity-provider URLs, callback overrides or claims from ordinary API requests.

SSO sign-out ends the local Store session. It does not promise to terminate the identity provider's organization-wide session or revoke other applications' credentials. Existing interactive sessions carry their sign-in claims; changes to provider accounts/groups require a fresh sign-in or Store restart before new claims are evaluated. Configuration changes require restart. Store API credentials are separate persisted credentials: revoke them explicitly or let their configured expiry apply. Do not assume SCIM provisioning, token introspection, provider back-channel logout or instant organization-wide revocation.

## Deliberate local recovery

OIDC errors never silently enable local sign-in. In `hybrid`, the configured local sign-in is an explicit operator choice. In `oidc`, an operator with filesystem/service control can stop Store, restore a reviewed `local` or `hybrid` authentication configuration, and use the local administrator recovery command when necessary.

Stop Store first. Prepare a new private JSON password file, outside the repository, containing `{ "username": "YOUR_EXISTING_ADMINISTRATOR", "password": "YOUR_NEW_PRIVATE_PASSWORD" }`. Supply the path, never the password itself:

```sh
node src/cli.js reset-password \
  --data-dir /absolute/path/to/archive \
  --password-file /absolute/path/to/private-password.json
```

The command requires the archive lock and an existing local administrator. It resets the existing local account to the operator-supplied username/password, revokes Store API credentials, and records the recovery action. It does not modify the selected authentication mode or create a new OIDC mapping. Remove the temporary password file securely after recovery and issue replacement integration credentials deliberately. Starting Store in OIDC-only mode still disables local HTTP sign-in.

## Upgrade and downgrade boundary

0.6.0 upgrades local authentication state to version2 and the archive catalog to schema3. The catalog bump is a security downgrade fence: pre-0.6 runtimes refuse the upgraded archive instead of interpreting role-bound credentials as unrestricted old administrator tokens. Original DICOM bytes are not rewritten.

Stop Store and make a verified full backup with the old runtime before the first 0.6.0 start. Preserve that runtime and backup. Rollback means restoring the pre-upgrade backup into a separate directory and opening that restored directory with the matching older build. Do not edit SQLite `user_version`, copy old `auth.json` into the changed archive, or bypass the version fence. A current full restore preserves token role, expiry and revocation state; a historical backup still contains its historical credentials and must be reviewed before network exposure.

## Audit, backup and limits

Security-sensitive administrative actions record the acting principal and role separately from original medical data. No plaintext password, API token, OIDC token or client secret belongs in audit output. This provides operator attribution for supported actions; it is not a complete regulatory audit policy.

Full offline archive backups include local authentication/token state and persisted security history. The external authentication configuration, provider client registration, TLS keys and separately mounted remote credential files are deployment inputs: back them up through an appropriately protected process. Restore drills must test both the archive and the intended identity configuration. Browser sessions do not survive restart or restore. A restored backup can contain credentials that were valid when the backup was made; review and rotate them before exposing the restored service.

This profile does not implement SAML, SCIM, multiple simultaneous OIDC providers, per-patient tenancy, granular clinical authorization or DICOM TLS. Synthetic OIDC tests qualify protocol validation against a controlled provider, not Entra ID, Okta, Keycloak or any other organization's live deployment. Record real-provider and reverse-proxy qualification separately before claiming that support.
