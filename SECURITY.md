# Security reports

Report suspected vulnerabilities privately to **dvaccaro@xinonix.com** with the
EASI Store version, affected deployment profile, and steps using independently
generated data. Do not include passwords, access tokens, original DICOM files,
patient information, or private identity-provider claims.

Please avoid posting an exploitable vulnerability in a public issue before
coordinating a fix. Ordinary bugs can use public issues with synthetic examples.

The supported first-release profile is a single-host archive with SQLite and
local filesystem storage. Local research access is an explicit workstation-only
option. Hosted use requires authenticated access and the documented HTTPS
deployment. Native DIMSE uses its separately configured AE/source-IP policy;
this release does not implement DICOM TLS or per-patient/tenant authorization.

Release-specific evidence, operating limits, update and backup procedures live
in the repository documentation. This policy does not promise clinical
qualification, an enterprise support SLA, or a particular response time.
