# CLAUDE.md

Guidance for AI agents working in this repository. Read this before changing code.

For *what* this project is and why it is designed this way, read [README.md](README.md) —
especially the architecture note. This file covers *how to work in it*.

---

## Repository shape

Two independently installed packages plus root-level tooling. There is no npm workspace; each
package has its own `node_modules`.

| Path | What it is |
| --- | --- |
| `api/` | Apollo Server 5 + Prisma 6 + Postgres. TypeScript, ESM, strict. |
| `web/` | Next.js 16 App Router + MUI 9 + RTK Query. TypeScript, strict. |
| `biome.json`, root `package.json` | Lint, format, git hooks. Run from the repo root. |
| `docker-compose.yml` | Postgres 17. Everything assumes this is running. |

Node 24 is required (`.nvmrc`, `engines`).

---

## Commands

Always run these from the directory shown.

```bash
npm start         # root — everything: env files, installs, Postgres, migrate, seed, run
```

`npm start` is idempotent: it installs only what is missing and **will not reseed** a
database that already has users, so it is safe to run repeatedly. Reseed deliberately with
`npm --prefix api run seed`.

| Directory | Command | Purpose |
| --- | --- | --- |
| root | `npm start` | **Use this by default.** Sets everything up, then runs both services. |
| root | `npm run dev` | Both services only, assuming setup is already done |
| root | `npm run dev:api` / `dev:web` | One service alone, when you want its logs isolated |
| root | `npm run db:up` / `db:down` | Postgres only |
| root | `npm run verify` | Lint + typecheck both packages. **Run before claiming done.** |
| root | `npm run lint:fix` | Biome check + autofix |
| root | `npm test` | Delegates to the api suite |
| `api/` | `npm test` | Integration tests against real Postgres |
| `api/` | `npm run seed` | Reset and reseed dev data (truncates first) |
| `api/` | `npm run db:reset` | Drop, re-migrate, reseed |
| `api/` | `npm run check:ledger` | Assert on-hand matches the movement ledger |
| `web/` | `npm run codegen` | Regenerate types from the API's SDL |

`npm run dev` uses `--kill-others-on-fail`, so a crash in one service stops the other instead
of leaving a half-running stack and an occupied port.

---

## Non-negotiable conventions

These are enforced by the schema, the migration, or review. Do not quietly break them.

### Database

- **UUIDv7 primary keys.** Prisma generates them via `@default(uuid(7))`. Raw SQL inserts must
  use `uuidv7()` from `api/src/shared/id.ts` — never `gen_random_uuid()`, which is v4 and
  destroys the time-ordering the ids exist for.
- **`created_at` / `updated_at` on every mutable table**, `timestamptz`.
- **Soft delete via `deleted_at`.** Read queries must filter it — spread `live` from
  `api/src/shared/prisma.ts` into the `where`. Two tables opt out on purpose and the schema
  explains why: `stock_movements` (append-only ledger) and `stock_on_hand` (derived projection).
- **Money is integer cents.** Never a float, never a decimal string. The UI converts to and
  from dollars at the form boundary only.
- **Uniqueness is partial** — `WHERE deleted_at IS NULL`. These live in the migration SQL, not
  in `schema.prisma`, because Prisma cannot express them.

### Derived state

`purchase_order_line_totals` and `purchase_order_status` are SQL views. Received quantities and
PO status are computed from the ledger, **never stored**.

If you find yourself adding a `status` column or a `quantity_received` column, stop — that is
the bug this design exists to prevent. Change the view instead.

### Stock writes

Every change to on-hand stock is two writes in **one transaction**:

1. Append a row to `stock_movements` (signed quantity, typed, attributed).
2. Move the `stock_on_hand` projection to match.

Never write `stock_on_hand` on its own. Never update or delete a movement — reverse it with a
compensating movement. `npm run check:ledger` will catch you if you do.

When adding a new movement type (adjust, transfer, allocate), extend
`api/src/domains/purchasing/service.ts` rather than writing a second path; the transaction and
locking logic is the part worth reusing.

### Authorisation

**Permissions are the unit of authorisation. Roles are just named bundles of
them, and nothing in the codebase branches on a role key.** If you find yourself
writing `role === 'warehouse'`, stop — that is the coupling this design removes.

**Every root field is default-deny.** The policy lives in one table in
`api/src/shared/authorize.ts`, and `src/schema.ts` wraps every Query and Mutation
resolver with it as the schema is built. `assertPolicyIsComplete` then runs at
boot and **refuses to start** if any root field is missing from the table.

That structure exists because the previous approach — a `requirePermission` call
written by hand in each resolver — failed exactly how you would expect: the
mutations were guarded, every read query shipped unguarded, and business data
was readable with no session at all. Nothing caught it, because nothing was
checking that a check existed.

So: **do not add `requirePermission` to a new resolver.** Add the field to
`POLICY` instead. If you forget, the server will not boot, and the error names
the field.

- A user may hold several roles. Effective permissions are the **union**, so
  roles add access and never remove it.
- Only root fields are wrapped; nested fields are reached *through* a root
  field, so gating the entry point gates the subtree.
- `PUBLIC` entries need a comment saying why. There are four, all of them
  necessary to obtain a session.

The UI mirrors this via `can(user, PERMISSIONS.X)` in `web/src/lib/session.ts`.
**The UI copy is cosmetic.** A client-side check is never a substitute for the
server-side one.

Access tokens carry the permission list, so a permission change takes effect on
the next access token (≤15 min), not instantly. That is the same bounded
staleness already accepted for the session, and the reason the TTL is short.

### Authentication

Access token = short-lived JWT, stateless. Refresh token = opaque, hashed in the DB, rotated
on every use, with reuse detection that revokes the whole family.

Three things in this area will bite you if you change them carelessly:

- **Never revoke inside a transaction that then throws.** Reuse detection has to persist the
  revocation *and* reject the caller; a rollback silently undoes the revocation and leaves the
  stolen session alive. This was a real bug, caught by a test.
- **The refresh claim must stay a single conditional `UPDATE`** (`rotated_at IS NULL` in the
  `where`). Read-then-write lets two concurrent refreshes both succeed.
- **The client must single-flight refreshes** (`refreshInFlight` in `web/src/lib/api.ts`).
  Parallel refreshes are indistinguishable from theft, so dropping the mutex makes the app log
  users out by itself.

Never read a token TTL at module load — use the lazy accessors in `shared/tokens.ts`. A
module-level `process.env` read captures whatever was set when the file was first imported,
which silently ignored `.env`. `shared/env.ts` loads the file and `readInt` reads at call time.

---

## Logging

Structured logging with pino. `logger` in `api/src/shared/logger.ts` is the root;
**prefer `ctx.log` in resolvers** — it is a child logger bound to the request, so
every line carries the same `requestId` and a failure can be traced end to end.

- An inbound `x-request-id` is honoured, so a trace started upstream continues.
- `redact` in the logger config strips anything credential-shaped: authorization
  and cookie headers, passwords, tokens, hashes. **Add to that list when you add
  a field that could carry one** — a token in a log file is a leak that outlives
  the request and gets copied into every downstream system.
- `loggingPlugin` writes one line per GraphQL operation with name, duration and
  error count. Expected rejections (a permission denial) log at debug; operations
  slower than `SLOW_OPERATION_MS` log at warn; only genuine faults reach error.
- Auth events (`auth.login`, `auth.logout`, `auth.refresh_reuse`) are logged with
  an `event` field so they can be alerted on. Refresh-token reuse is a warn.
- Tests run at `silent`. Set `LOG_LEVEL` to change it locally.

---

## Lists: filtering and pagination

**All filtering is server-side.** If you find yourself calling `.filter()` on a result set
in a component, stop — it only filters the page already loaded, which is wrong as soon as
there is more than one page. Add the field to the GraphQL filter input and to
`repository.ts` instead.

- Filters, ordering and the keyset window compose into **one** SQL statement. Never fetch
  a set of ids and then re-query to narrow it.
- Build SQL with `Prisma.sql` / `Prisma.join`, never string interpolation. Escape `%` and
  `_` in anything that reaches a `LIKE`.
- Pagination is keyset, not offset. Fetch `limit + 1` and let `buildPage` derive
  `hasNextPage`; do not add a second COUNT for it.
- `findMany({ where: { id: { in: ids } } })` does **not** preserve order — pass the result
  through `inIdOrder` or the SQL sort is silently discarded.
- Changing a filter must reset pagination. A cursor belongs to one result set.

### Indexes

New query shapes need indexes built for them. Check the plan before and after with
`EXPLAIN (ANALYZE, COSTS OFF)` against enough rows for the planner to have a real choice —
on a small table everything looks like a seq scan and proves nothing.

- Filter column + sort column belong in **one** index, in that order.
- Partial on `deleted_at IS NULL` where the query always carries that predicate.
- Leading-wildcard `ILIKE` needs a trigram GIN index; a btree cannot serve it.
- Prisma cannot express partial, DESC-ordered or GIN indexes, so they live in migration SQL
  and the corresponding `@@index` is left out of `schema.prisma` to avoid drift.
- Don't keep an index the planner does not choose. Verify, then keep or drop.

---

## Multi-tenancy

Every row of business data belongs to one tenant. The filter is **injected**, not written at
each call site — `shared/tenancy.ts` holds a Prisma client extension and an
`AsyncLocalStorage` store, and `assertTenancyIsComplete` refuses to boot if a model is
neither scoped nor explicitly global.

Rules:

- **Use `prisma` from `shared/prisma.js`.** `prismaUnscoped` exists for exactly two jobs —
  seeding, and resolving which tenant a sign-in belongs to — and nothing else should import it.
- **Never add `tenantId` to a read `where`.** The extension does it. If a read needs a
  different tenant, that is a design problem, not a query problem.
- **Writes name the tenant explicitly**, from `requireTenant()`, never from input. A missing
  one fails the NOT NULL constraint loudly; a missing *read* filter would be silent, which is
  why the extension guarantees reads.
- **Raw SQL bypasses the extension.** `repository.ts` and the `FOR UPDATE` lock in
  `service.ts` carry their own `tenant_id` predicate, and `tenancy.test.ts` fails if one is
  removed.
- **Uniqueness is per tenant** — `(tenant_id, code)`, not `code`. Email is the exception: it
  is the login identifier, resolved before a tenant is known.

Two traps that already cost time here, both now covered by tests:

- **`AsyncLocalStorage.enterWith` in the GraphQL context does not work.** The store is gone
  by the time resolvers run. The tenant is bound by Express middleware wrapping the request in
  `storage.run` — which is why this is not on `startStandaloneServer`.
- **Prisma promises are lazy.** Returning one from inside the store without awaiting it
  dispatches the query outside the store. `withTenant` awaits internally so callers cannot
  reintroduce it.

The honest limit: this is application-level enforcement. Postgres RLS is the hardening step,
and the README says so rather than implying the database is enforcing it.

## Feature switches

`shared/features.ts` holds the catalogue; `tenant_features` holds the per-tenant setting.
**Absent means off** — match that default in the UI, or you render a page the API refuses.

A feature is **not** a permission, and they are separate tables in `authorize.ts`. A
permission asks *may this user*; a feature asks *does this tenant have it at all*. Use
`FEATURE_GATES` for the second, and let it produce `FEATURE_DISABLED` rather than `FORBIDDEN`
— the two are fixed by different people.

---

## Layering

```
resolvers.ts   →  role check + shape translation. Thin. No business rules.
service.ts     →  domain rules + transaction boundaries. No GraphQL types in signatures.
loaders.ts     →  per-request DataLoaders. Batching only.
```

The rule that matters: **`service.ts` must be callable from a worker, a CLI or an import job**
without going through GraphQL. If you are tempted to pass a resolver `args` object or a
GraphQL context into a service, the logic is in the wrong place.

### Adding a domain

A domain is a folder under `api/src/domains/` exporting `{ typeDefs, resolvers }` (see
`purchasing/index.ts`). Add the folder, then add one line to `api/src/schema.ts`. Nothing else
in the server changes.

---

## Frontend rules

- **MUI 9 removed system props.** `justifyContent`, `alignItems`, `display`, `fontWeight` and
  friends are **not** valid as direct props — they go in `sx`. This is the single most common
  typecheck failure in `web/`.
- **No one-off hex values.** Colours and spacing come from the theme in `web/src/lib/theme.ts`.
  PO statuses use the registered `palette.status` entries.
- **All GraphQL documents live in `web/src/lib/operations.ts`** with the `/* GraphQL */` marker
  so codegen can find and validate them. After editing a document or the API's SDL, run
  `npm run codegen` — otherwise types silently go stale.
- **Loading / empty / error states go through `QueryState`.** Do not hand-roll a spinner.
- **Cache invalidation is tag-based.** A mutation that changes data another screen shows must
  invalidate that screen's tag. Receiving invalidates the PO, the list (status is a filter), and
  `StockOnHand`.

---

## Testing

Tests are integration tests against a real Postgres, in `api/tests/`. They create and migrate a
separate `daas_test` database via `tests/global-setup.ts`; they never touch dev data.

**Write tests for behaviour that would hurt in a warehouse**, not for coverage. The existing
suite covers over-receipt rejection, all-or-nothing multi-line receipts, concurrent receipts
racing for the last item, location overrides, and ledger/projection agreement. Follow that
style: each test name describes a scenario a warehouse manager would recognise.

Do not mock Prisma. The behaviour worth testing here — transaction rollback, `FOR UPDATE`
serialisation, check constraints, SQL views — lives in the database. A mock would assert that
we called the functions we wrote, not that receiving is correct.

Gotcha: Vitest loads `api/.env` into `process.env`, which is why the test database URL lives in
`api/tests/database-url.ts` and is imported by both the Vitest config and the global setup.
Do not read `process.env.DATABASE_URL` in test setup code — you will get the dev database.

---

## Dependency gotchas

- **`prisma generate` runs from `api`'s `postinstall`.** npm 11 blocks dependency install
  scripts by default, so Prisma's own postinstall may not fire; ours does, because a package's
  own scripts still run. If you ever see *"@prisma/client did not initialize yet"*, run
  `npm --prefix api run prisma:generate`.
- **`api/prisma.config.ts` replaces the deprecated `package.json#prisma` block.** Having it
  switches off Prisma's automatic `.env` loading, which is why the file loads `.env` itself —
  and why it only does so when `DATABASE_URL` is not already set, so the test global-setup can
  still point the CLI at `daas_test`.
- **Two `overrides` exist and both are deliberate**, each with a comment saying why:
  `deepmerge-ts` in `api/` and `lodash` in `web/`. Both patch advisories in build-time tooling
  that upstream has not fixed in a usable release. Re-check them before upgrading Prisma or
  GraphQL Codegen; if upstream has caught up, delete the override rather than carrying it.
- **Keep `npm audit` clean** in all three packages. It is currently at zero.

## Style

Biome handles lint and format; there is no ESLint or Prettier. Run `npm run lint:fix` from the
root rather than hand-formatting. Husky + lint-staged enforce this at commit time.

Notable enabled rules: `noExplicitAny`, `useAwait`, `noArrayIndexKey`,
`useExhaustiveDependencies`, `useImportType`, plus the React, Next and a11y rule sets.

Comments should explain **why**, not what. The existing code comments the non-obvious calls —
why the row lock is there, why the upsert is raw SQL, why two tables skip soft delete. Match
that density; do not narrate obvious code.
