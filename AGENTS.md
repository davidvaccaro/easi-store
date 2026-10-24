# Instructions for EASI Store coding agents

EASI Store is an independent DICOM archive/server repository. EASI JS is the parsing dependency; EASI View is the independently packaged viewer. Do not modify or fork sibling projects incidentally.

- Preserve the modular server architecture and durable ingestion boundary. Success must follow durable object storage and committed catalog state, including for future DIMSE acknowledgments.
- Preserve original DICOM bytes. Treat duplicate/conflicting UIDs explicitly; never silently replace a stored object.
- Use the existing EASI JS streaming selection/parser abstractions. Do not decode or retain pixel data merely to index metadata.
- The SQLite database and filesystem form one archive; implement reconciliation for interruptions between their commits. Enforce a single writer per data directory.
- Keep patient identity scoped by issuer/source. Matching a name alone must not merge patients.
- All data/API routes require authorization. Keep local startup bound to loopback by default; do not introduce default credentials or wildcard CORS.
- Never modify `.env*` files, commit credentials, imaging corpora, local archive databases, or backups. Tests/demos must generate independent synthetic DICOM data.
- An import into Store really uploads to the server. Product copy must distinguish this from standalone EASI View's local file viewing.
- Do not call partial metadata complete, imply support for unimplemented transfer-syntax conversion, or claim full DICOMweb, Orthanc parity, clinical validation, or production qualification without evidence.
- Preserve EASI Store's source-available Community License and third-party notices. Do not copy GPL/AGPL PACS implementations into this independently licensed implementation.
- Keep changes focused. Add meaningful tests for behavior changes; use `npm run check`, relevant targeted tests, and the packaging test when changing launchers/artifacts.
- Match actual launch/runtime behavior in README and docs. Signing, native installer qualification, Windows/Linux smoke tests, and production readiness must be stated accurately.
