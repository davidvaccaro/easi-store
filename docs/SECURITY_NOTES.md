# Release security inventory — 1.0.0-rc.1

The candidate's locked application runtime and build dependency audits reported
no known npm advisories on 2026-10-28. That result does not cover every operating
system package or Node's separately bundled tools. The final release inventory
and full image scan are published alongside the candidate; they are dated
engineering evidence, not a promise that the product is vulnerability-free.

The image scan uses Trivy 0.76.1 and the pinned Node 24.22.1/bookworm base. The
release gate blocks **fixable HIGH or CRITICAL** findings. Full reports retain
vendor-deferred/unfixed findings instead of suppressing them. Rebuild/requalify
with reviewed vendor updates; a fixed image tag is not an automatic patch policy.

## Removed unused package managers

Initial image scanning found six fixable HIGH rows in npm's bundled `undici` and
`brace-expansion`. The server starts directly with Node, so Docker and portable
runtimes now omit unused npm/npx/corepack (and Docker's unused yarn) after locked
application dependency installation. Node itself, required app modules and
licenses remain. This follows the [official docker-node packaging guidance](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#smaller-images-without-npmyarn).

The final npm-free image scan reported zero fixable HIGH/CRITICAL findings. It
still reported vendor-unfixed/deferred Debian findings, including a CRITICAL
row for `zlib1g`/CVE-2023-45853. Debian's tracker explains that this issue concerns
contributed MiniZip code not built into the affected bookworm binary package;
retain that applicability context with the original scanner result. See the
[Debian security tracker](https://security-tracker.debian.org/tracker/CVE-2023-45853).

Remaining HIGH classes include local mount/utility, gzip, ncurses and other
base-system paths. Store's request handlers do not call those CLI utilities;
that observation is not a blanket non-applicability declaration for a compromised
host or different deployment. Continue to review the full scan and vendor fixes.
Run as the nonroot service user, with a read-only root filesystem, dropped
capabilities, no new privileges, protected data volume and deliberate network
publication. The [supported profile](CONFORMANCE.md) and [operations guide](OPERATIONS.md)
define the evaluated topology and its limits.

## Source and artifact review

Before source publication, the release review scans all Git refs/history and the
candidate with pinned Gitleaks/default rules and redacted reports, checks owned
source/build artifacts for original DICOM/database/private-state assets, and
verifies each released package against its checksum and complete file inventory.
An automated clean scan cannot certify that every possible secret or identifier
is absent. Original corpora, live archives, backups, credentials and per-file
qualification reports remain local private inputs and are excluded from releases.

See [SECURITY.md](../SECURITY.md) for private vulnerability reports. Never include
medical data, credentials or real identity tokens in public issue attachments.
