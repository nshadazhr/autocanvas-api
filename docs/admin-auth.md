# Admin authentication backend

## Pehle ye padhein: simple overview

Is document ka purpose hai ki auth code baad mein samajhna aasaan rahe. Functionality abhi preserve ki gayi hai; sirf code kam dikhane ke liye security checks remove nahi karne hain.

- **USER**: normal application use karta hai.
- **ADMIN**: admin login/check use kar sakta hai; doosre accounts ke roles manage nahi kar sakta.
- **SUPERADMIN**: admin access ke saath role management aur role-audit APIs use kar sakta hai. Private runtime settings endpoints bhi current SUPERADMIN guard enforce karte hain.

User, admin aur superadmin ke liye teen alag login systems nahi hain. User/admin dono `AuthService.login()` aur `TokenService` reuse karte hain. Superadmin bhi admin login use karta hai; uske permissions current database role se decide hote hain.

### Flow ko aise samjhein

1. **Login:** origin check → login attempt limit → input validation → password/role check → database session create → access token response + HttpOnly refresh cookie.
2. **Protected request:** access token ka signature/audience/kind → active database session → route ke hisaab se admin/superadmin role check.
3. **Refresh:** correct application ki refresh cookie → token/hash/session check → admin refresh ke liye current role check → same session ka access token. Refresh session ki one-day expiry extend nahi karta.
4. **Logout:** current refresh cookie se session revoke → cookie clear. Us session ke access/refresh tokens future requests mein reject honge; doosre independently logged-in sessions valid rahenge.
5. **Role change:** superadmin guard → transaction ke andar actor/session dobara check → last-superadmin check → role update + target ke existing sessions revoke + audit entry. Ye sab ek transaction mein hota hai.

### Kaunsi file kab padhein

All paths below are relative to the backend project root.

| File                                      | Responsibility / reusable part                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/auth/auth.controller.ts`             | Auth routes aur cookie set/clear helper. Login/refresh/logout ko service se connect karta hai.                    |
| `src/auth/auth.service.ts`                | Existing login, registration/OTP aur Google flow; `login(..., adminOnly)` user/admin logic reuse karta hai.       |
| `src/auth/services/token.service.ts`      | Shared token issuance, audience/purpose validation, database-session checks aur revocation.                       |
| `src/auth/auth.guard.ts`                  | AuthGuard user session check karta hai; AdminAuthGuard isi class ko extend karke admin audience select karta hai. |
| `src/auth/services/admin.guard.ts`        | Current database role ADMIN/SUPERADMIN hai ya nahi. Client ki role claim par trust nahi karta.                    |
| `src/auth/services/superadmin.guard.ts`   | AdminGuard reuse karke sirf SUPERADMIN allow karta hai.                                                           |
| `src/auth/services/auth-origins.ts`       | CORS aur auth Origin checks ke liye common application allowlists.                                                |
| `src/auth/services/auth-origin.guard.ts`  | Auth mutations ko corresponding user/admin browser origin tak restrict karta hai.                                 |
| `src/auth/services/login-rate.guard.ts`   | Password verify karne se pehle shared, database-backed login limits.                                              |
| `src/auth/admin-roles.controller.ts`      | Superadmin-only user-list, role-change aur audit-list routes. Business logic service mein hai.                    |
| `src/auth/services/admin-role.service.ts` | `changeRole()`, locked transaction, session revocation, audit aur server-only `bootstrap()` logic.                |
| `src/auth/dto/admin-role.dto.ts`          | Allowed roles, reason length aur bounded query/pagination validation.                                             |
| `src/scripts/bootstrap-superadmin.ts`     | Server command; existing role service reuse karta hai. Public bootstrap endpoint nahi hai.                        |
| `src/auth/auth.module.ts`                 | Providers/controllers register karta hai; reusable guards/TokenService export karta hai.                          |
| `prisma/schema.prisma`                    | User role, AuthSession, AuthRateBucket aur AdminRoleAudit ka data structure.                                      |

Reading order: **controller → AuthService → TokenService → guards**. Role management samajhna ho tab **AdminRolesController → AdminRoleService → bootstrap command** padhein. Generated Prisma files ko manually edit nahi karna hai.

### Security fixes aur optional features mein farq

Yahan “required” ka matlab current chosen behavior ko safely maintain karne ke liye required hai; har application ko ye saare features implement karna mandatory nahi hai.

| Part                                                         | Kyun hai                                                          | Classification                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Password/user record logging remove karna                    | Password hash aur account data logs mein na jaaye.                | Actual security fix.                                                                                       |
| Server-side admin/superadmin checks                          | Normal user ko privileged APIs na milen.                          | Permission security ka core part.                                                                          |
| CORS mein admin origin                                       | Admin frontend backend response access kar sake.                  | Functional integration fix.                                                                                |
| Persisted sessions + logout revocation                       | Logout ke baad copied tokens reuse na hon.                        | Required for the implemented revocation guarantee.                                                         |
| Separate audiences, token kinds, cookies and origins         | User/admin sessions aur access/refresh tokens interchange na hon. | Session separation security.                                                                               |
| Login limits                                                 | Repeated password attempts ko limit karna.                        | Recommended security hardening; basic login iske bina bhi function karta hai.                              |
| Role-change transaction, revocation and last-superadmin lock | Role management se stale access ya concurrent lockout na ho.      | Required protection while role-management API is enabled.                                                  |
| Audit record save karna                                      | Kisne, kis account ka role, kyun aur kab badla trace ho sake.     | Useful security accountability; basic login ke liye mandatory nahi.                                        |
| User-list search, role filters and cursor pagination         | Future admin UI ko accounts find karne mein help.                 | Optional management/UI support, already implemented. Bounded pagination endpoint ko controlled rakhti hai. |
| Audit-view API and pagination                                | Audit records ko admin UI mein dekhna.                            | Optional viewing feature; audit write se separate hai.                                                     |
| Same-role request ka `changed: false` response               | Repeat click se unnecessary logout/audit entries na banen.        | Convenience/idempotency behavior.                                                                          |
| Server bootstrap command                                     | Public role-grant endpoint ke bina pehla superadmin setup.        | Initial operational setup; daily login flow ka part nahi.                                                  |

Decision: implemented features abhi rakhe gaye hain. Future mein simplification chahiye to duplication ya unclear responsibilities se shuru karein; security behavior silently remove na karein. Extra login systems, generic permission frameworks ya unused layers add karne ki abhi zarurat nahi hai.

### Maintenance aur debugging

- New ordinary API: existing AuthGuard reuse karein.
- New admin API: AdminAuthGuard + AdminGuard reuse karein.
- Superadmin-only API: AdminAuthGuard + SuperAdminGuard reuse karein; browser mutations par existing Origin guard bhi lagayein.
- Application se roles change karne ke liye AdminRoleService use karein. Direct `user.update({ role: ... })` se lock, revocation aur audit bypass ho jayenge.
- Failed role-change audit par transaction rollback intentional hai: audit fail hua to role/sessions partially update nahi hone chahiye.
- Existing account ko normal USER banana administrator access remove karne ka supported way hai. Account-delete API expose nahi ki gayi.
- JWT_SECRET, JWT_REFRESH_SECRET, passwords, raw access/refresh tokens aur password hashes logs/docs mein paste na karein.
- Frontend route hiding security boundary nahi hai; backend guards authoritative hain. Admin frontend screens abhi pending hain.

| Symptom                         | Pehle kya check karein                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 401                        | Access token expired/revoked/legacy hai? User token admin endpoint par to nahi bheja? Refresh cookie correct hai? Role change/logout ne session revoke to nahi kiya? |
| HTTP 403                        | Current DB role aur browser Origin check karein; normal app origin se admin cookie operation intentionally blocked hai.                                              |
| HTTP 409 on role change         | Target last superadmin to nahi hai? First-superadmin bootstrap existing superadmin ke baad different account ke liye intentionally blocked hai.                      |
| HTTP 429 on login               | Retry-After follow karein; account/IP limit, repeated successful attempts aur trusted reverse-proxy configuration check karein.                                      |
| Bootstrap account reject hua    | Account pehle register + email verify hona chahiye; password login enabled hona chahiye. Command account create/auto-verify nahi karta.                              |
| Tables/types missing at startup | Neeche listed migrations deploy hui hain aur Prisma client generate hua hai ya nahi check karein.                                                                    |

Detailed endpoint contracts, configuration, bootstrap steps aur test commands neeche hain.

User and admin authentication have independent server-side sessions. Admin login is restricted to current ADMIN/SUPERADMIN accounts; registration continues to create USER accounts. Only authenticated SUPERADMIN sessions may change roles through the role-management API below.

## Routes

| Purpose        | User application   | Admin application        |
| -------------- | ------------------ | ------------------------ |
| Password login | POST /auth/login   | POST /auth/admin/login   |
| Refresh        | POST /auth/refresh | POST /auth/admin/refresh |
| Logout         | POST /auth/logout  | POST /auth/admin/logout  |
| Session check  | GET /auth/profile  | GET /auth/admin/check    |

Login responses contain the access token and safe user fields. Refresh tokens stay in separate HttpOnly cookies (`refresh_token` / `admin_refresh_token`). Cookies use Secure + SameSite=None in production and SameSite=Lax for local development. Admin check returns current id, name, email and role from the database.

## Session enforcement

- JWTs carry a session ID, explicit access/refresh kind and distinct `autocanvas-user` / `autocanvas-admin` audiences. Cross-purpose and cross-application tokens are rejected.
- PostgreSQL AuthSession stores only the SHA-256 refresh-token hash, ownership, realm, expiry and revocation time. Raw tokens/password hashes are not logged.
- Access tokens expire after 15 minutes; sessions and refresh tokens last one day. Refresh returns a new access token within the existing session lifetime; it does not extend or rotate the refresh token.
- Every authenticated request checks the persisted session. Logout revokes that session before clearing its cookie, including all access tokens issued through it. Other independently logged-in sessions remain valid. Already-running requests are not recalled by logout.
- AdminGuard checks the current database role on every admin request. Role demotion blocks admin checks and refresh. Deleting a user cascades their sessions.
- New administrative controllers must use `@UseGuards(AdminAuthGuard, AdminGuard)`. Ordinary APIs use AuthGuard, which accepts only the user audience. The guards and TokenService are exported from the global AuthModule.

Deploy migration `20261024050000_revocable_auth_sessions` before starting the updated backend. Legacy tokens have no persisted session and are rejected: existing users/admins must sign in once after this upgrade. Existing story/audio data is not changed.

## Browser origins and request protections

- REQUEST_ORIGIN_PORT: primary user application origin; local default `http://localhost:3000`. Set the real HTTPS origin explicitly in production.
- ADMIN_ORIGIN: primary admin origin; local default `http://localhost:3001`. Set the real HTTPS origin explicitly in production.

Both apps use localhost fallbacks only outside production. In production, a missing origin leaves that app's allowlist empty; password-reset requests also fail before creating a token or sending email when the user origin is missing. Global CORS allows configured origins with credentials. Auth mutations additionally validate Origin against the corresponding application allowlist; the user application's origin cannot refresh/logout the admin session. Untrusted origins and cross-site requests missing Origin are rejected. Non-browser clients without Origin remain supported and must possess the appropriate credentials/token.

JWT_SECRET and JWT_REFRESH_SECRET must be strong independent server-only secrets. Missing refresh-secret configuration fails backend initialization; it never falls back to the access-token signing key.

## Password recovery

`PasswordResetController`, `PasswordResetService` and `PasswordResetRateGuard` implement public user-origin recovery using the existing Prisma, PasswordHasher, EmailService and AuthRateBucket infrastructure. Login/registration/OTP handlers are unchanged.

- `POST /auth/forgot-password` accepts `{ email }` (trimmed/lowercased, maximum 254 characters). HTTP 200 has the same generic response for known, unknown, unverified and Google-only accounts. Only verified accounts with a password receive mail. Google-only users continue using Google sign-in; recovery does not create a password for them.
- Email uses existing `RESEND_API_KEY` and optional `RESEND_FROM_EMAIL`. Links use the trusted primary `REQUEST_ORIGIN_PORT` origin (local default `http://localhost:3000`), never request-supplied host fields. Use the deployed HTTPS origin in production. Missing API-key configuration returns 500 for all requests. Provider-delivery failure logs a generic warning, removes that failed issuance and retains the generic response without exposing account eligibility. Check provider delivery if mail does not arrive.
- Links use `/reset-password#token=...`: the fragment is absent from HTTP page requests/referrers. A 32-byte random token expires after 30 minutes. `PasswordReset` stores only its SHA-256 digest, with at most one outstanding record per user. A new request replaces the previous token. Never log passwords, tokens, reset URLs or email-provider errors.
- `POST /auth/reset-password` accepts `{ token, password }`: token must be 64 lowercase hex characters; password must be strong (8–1024 characters, upper/lowercase, number, symbol). Invalid, expired, replaced or used links return 400 with `code: RESET_TOKEN_INVALID`. Input validation failures are also 400.
- Token consumption, saving the password hash and revocation of **all user/admin sessions** occur in one transaction. Only one concurrent submission succeeds. Transaction failure preserves the prior password/token. Success returns 200, clears both refresh cookies and asks the user to log in; no new session is issued. Existing access/refresh tokens fail normal session guards.
- Responses use `Cache-Control: no-store`. AuthOriginGuard rejects untrusted origins. Separate fixed 15-minute buckets allow 3 requests per normalized email and 20 per peer IP; reset submissions allow 30 per peer IP. Excess requests return 429 with `Retry-After`. Reset traffic does not consume password-login buckets. Forwarded IP handling follows the existing trusted-proxy rules.

Deploy additive migration `20261028100000_password_reset` and regenerate Prisma before using these endpoints:

```sh
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
```

With `AUDIO_FLOW_TEST_DATABASE_URL` pointing to a disposable localhost database ending in `_test`, run:

```sh
npx vitest run --config vitest.password-reset.config.ts
```

The PostgreSQL/HTTP suite covers eligibility/generic response bodies, digest storage, expiry/replacement/replay, real password login before/after reset, both session realms, concurrent consumption, transaction rollback, input/origin/rate protections and mocked mail failures. Sender tests do not send real email. Migration deployment was verified there and the single additive migration was applied to the verified local app database. Live inbox delivery remains an operational verification.

## Password-login rate limits

Limits are persisted in AuthRateBucket, shared across backend replicas, and enforced before password verification. They count admitted login requests, including successful logins, in fixed 15-minute UTC windows. Defaults:

| Scope                | Admin | User |
| -------------------- | ----- | ---- |
| Per normalized email | 5     | 10   |
| Per peer IP          | 30    | 60   |

Super Admins manage these four limits in admin **Login security** (`/security-settings`) through `GET/PATCH /admin/config/security`. Values are normal JSON numbers in `Configuration.backend_settings.security`, not encrypted credentials. Keys are `adminLoginAccountLimit`, `adminLoginIpLimit`, `loginAccountLimit` and `loginIpLimit`; accepted values are integers 1–1,000,000, with no zero/disable option. Private reads and writes require an admin-realm session and the current SUPERADMIN database role; writes retain the existing origin guard. These values never enter public `/app-config`.

Saved overrides take priority over legacy `ADMIN_LOGIN_ACCOUNT_LIMIT`, `ADMIN_LOGIN_IP_LIMIT`, `LOGIN_ACCOUNT_LIMIT` and `LOGIN_IP_LIMIT`, then the defaults above. Reset removes saved overrides, restoring the environment/default values. Each password-login attempt reads effective settings; edits apply without restart and do not reset existing counters, separate user/admin scopes or the 15-minute window. A settings-read error or invalid saved limit does not bypass throttling. Registration, Google login, refresh and password-reset throttles keep their existing flows. Preserve effective values and verify with these four environment entries omitted before removing them manually. Exceeding a limit returns HTTP 429 with Retry-After. Email/IP bucket identifiers are hashed. Arbitrary X-Forwarded-For headers are ignored; behind a reverse proxy, configure Express trust proxy for the known proxy addresses before relying on forwarded client IPs. Do not blindly trust all forwarded headers.

## Verification

Run against a disposable local database ending in `_test`; no application DATABASE_URL fallback is allowed:

```sh
AUDIO_FLOW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/autocanvas_auth_test node_modules/.bin/vitest run --config vitest.admin-auth.config.ts
```

The HTTP/PostgreSQL suite covers roles, sensitive logging, logout/replay, cross-application tokens, demotion, invalid/legacy tokens, input validation, concurrency/rate limits, independent sessions, origin checks and production cookie attributes. The audio/analysis regression suite remains separate under vitest.audio-flow.config.ts and uses a JWT-verification test double; real session enforcement is exercised by the auth suite.

Automated fixtures do not establish production deployment or live provider delivery.

## Superadmin role management

All role-management routes require an **admin-audience** session and a current SUPERADMIN database role. Ordinary ADMIN/USER accounts cannot use them. `SuperAdminGuard` reuses AdminGuard and is exported for other sensitive administrative endpoints; it does not create a separate login system.

- `GET /auth/admin/users?role=ADMIN&search=name&limit=25&cursor=123`: safe account fields only, optional role/search filters and ID cursor pagination (1–100 results).
- `PATCH /auth/admin/users/:userId/role`: body `{ "role": "ADMIN", "reason": "Reviewed team administrator access" }`. Valid roles are USER, ADMIN and SUPERADMIN; a 5–500 character reason is required. Targets must already be registered accounts. Privileged accounts require a verified email and password login enabled.
- `GET /auth/admin/role-audit?limit=25&cursor=123`: read-only role-change audit records, paginated by event ID.

Role changes, revocation of **all** target sessions (user/admin) and the audit write commit in one transaction. Audit failure rolls everything back. No-op same-role requests do not invalidate sessions or add duplicate audit entries. Shared PostgreSQL locking serializes all application role writers; actor role/session checks happen again inside the transaction. This prevents stale privileged requests and concurrent self-demotions from removing the last superadmin.

A last SUPERADMIN cannot be demoted. No account-deletion API is exposed: removing administrator access means changing the role to USER, preserving the user's account/data. These are application protections; direct privileged database operations remain the deployment operator's responsibility.

Audit records snapshot actor/target IDs, email identifiers, previous/new roles, reason and timestamp. They contain no passwords/tokens and are append-only through the API. Their identifiers remain available even if an operator later removes an account.

### First superadmin: server-only bootstrap

Register an account normally and verify its email. Then, in the backend directory:

```sh
npm run build
npm run admin:bootstrap -- --email registered@example.com
```

The command promotes that existing verified password account, revokes its old sessions and records a bootstrap audit event. Sign in again through `/auth/admin/login`. It does not create an account, set a password, auto-verify an email or expose a public bootstrap API. Once any superadmin exists, a different account cannot be bootstrapped; use authenticated role management. Re-running it for an existing superadmin is an idempotent no-op.

Migration `20261024060000_admin_role_audit` adds the audit table only. No real account is automatically promoted by deployment. Sensitive settings APIs can reuse SuperAdminGuard when they are introduced; no settings or frontend screens were added here.

Verification includes 37 auth/superadmin HTTP/PostgreSQL tests, 54 audio/analysis regression tests and a full Nest smoke test running the bootstrap command in a separate process with disposable accounts and real password hashing.

### User profile response

`GET /auth/profile` uses the existing user-session guard, then loads the current
user by the verified token ID. It returns only `{ id, name, email }` from the
database (name can be null), with `Cache-Control: private, no-store`. Missing
users receive 401. JWT/session claims, password hashes and credential fields are
not profile fields. This keeps the saved name available after browser reload;
login and token formats are unchanged.
