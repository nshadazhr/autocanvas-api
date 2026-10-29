# Documentation rules

After every code change:
- Check whether existing documentation needs updating before completing the task.
- Update affected docs when behavior, APIs, auth, configuration, database,
  storage, or setup changes. Keep documentation consistent with the final code.
- Reuse existing documentation; avoid duplicate documents and unnecessary edits.
- Clearly separate implemented and planned features.
- Never include secrets, tokens, or real credentials.
- Verify links and commands in updated documentation. Report any commands that
  could not be verified; do not claim they were tested.
- In the final response, mention which docs changed. If documentation needs no
  changes, briefly explain why.

Start with README.md for the documentation index. Update the relevant existing
guide in docs/ and update the index if documentation is added or moved.

# Runtime configuration and environment rules

- New or changed non-secret runtime controls (feature/maintenance switches,
  cleanup enablement, recovery policy and request/usage/login limits) belong in
  the existing private backend configuration and Super Admin dashboard, not only
  in environment variables or scattered hardcoded constants. Implement the
  backend consumer and admin control together within the authorized feature.
  Reuse an existing section/key and AppSettingsService/configuration writer;
  do not create a parallel configuration system.
- Backend guards must enforce current SUPERADMIN access for private setting
  reads/writes, with existing session/origin checks and server-side type/range
  validation. Hiding a control in the UI does not enforce authorization.
  Private runtime values must not be published through public app-config.
- Store non-secret settings as normal typed JSON values; encryption is not
  required for ordinary flags and numbers. Keep provider/API keys, signing
  secrets and credentials only in backend environment/hosting secrets. Do not
  reintroduce database/admin provider-key management.
- Keep deployment/infrastructure values in environment configuration: NODE_ENV,
  PORT, database connection, application origins and storage provider/account/
  bucket selection. Do not treat every environment value as a runtime control.
- Do not edit real .env files. Prepare safe .env.example/docs changes and give
  the user the exact variable names/lines to change or remove manually, without
  displaying real secrets. When moving an existing runtime value to admin,
  preserve its effective value and verify behavior without the legacy override
  before recommending removal. Do not silently change working settings.
- Apply these rules to the requested feature; do not migrate unrelated settings
  or remove existing data/compatibility without task-specific authorization.

# Code formatting and change scope

- Follow this repository's existing Prettier configuration and nearby code
  conventions. Format only the files/sections changed for the task; avoid
  whole-repository formatting or style-only churn in unrelated code.
- Keep new code readable: use normal multiline formatting for functions,
  conditions and structured values instead of compressed one-line blocks.
  Reuse existing helpers/components rather than duplicating behavior or styles.
- Preserve typed API contracts and machine-readable status/error identifiers.
  Keep dynamic user content separate from translated display text. Do not
  change working auth, billing, ownership, loading or error behavior as an
  incidental refactor.
- Run checks appropriate to the actual change and report what was verified.
  Keep documentation consistent with implemented behavior; do not describe a
  planned feature, stubbed test or unconfigured provider as live/verified.

# Backend maintenance

- Read the relevant guide and nearby services before editing. Reuse Prisma,
  configuration, provider/storage adapters, guards and shared error handling;
  avoid new ad hoc clients or duplicate settings/constants in individual methods.
- Keep backend error/status contracts consistent and keep secrets/scripts out
  of logs. User-facing frontend copy belongs to the corresponding frontend's
  localStrings catalog, not a new backend/frontend translation system.
- Keep schema changes in versioned Prisma migrations. Preserve existing data
  and immutable migration history unless the user explicitly authorizes a
  particular reset/deletion; a planned future reset is not permission to run it.
