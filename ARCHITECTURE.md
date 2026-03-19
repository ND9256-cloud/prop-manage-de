# Architecture

Read this before writing any code. No exceptions.

## Data access

- `public` schema → **Prisma client** (`src/lib/db.ts`)
- `warehouse`, `pm`, `connector` schemas → **Supabase client** (`src/lib/supabase.ts`)
- Never mix these. If you're unsure, check existing files in the same directory and follow the same pattern.
- Server actions that touch warehouse data use the Supabase client (see `src/lib/warehouse-actions.ts`).
- Server actions that touch public schema data use Prisma (see `src/lib/actions.ts`).

## Schemas

| Schema | Managed by | Purpose | Who writes to it |
|--------|-----------|---------|-----------------|
| `public` | Prisma | Users, orgs, memberships, invitations | App directly |
| `warehouse` | Raw SQL migrations | Documents, extractions, intelligence, jobs, review tasks | Pipeline + app |
| `pm` | Raw SQL migrations | Properties, units, tenants, leases, payments, ledger | **Only `connector.apply()`** |
| `connector` | Raw SQL migrations | Bridge functions (resolve + apply) | Pipeline |
| `shared` | Raw SQL migrations | Org isolation helpers (`current_org_id()`) | System |

**Key rule:** Warehouse code never reads or writes `pm.*` directly. Everything goes through `connector.resolve()` and `connector.apply()`.

## Pipeline

- `process-document` is a **Supabase Edge Function** (`supabase/functions/process-document/index.ts`), not a Next.js API route.
- Edge Function secrets (including `ANTHROPIC_API_KEY`) are in the **Supabase dashboard** under Edge Functions → Secrets. They are NOT in `.env` files.
- The pipeline writes to `warehouse.*` tables only. Writes to `pm.*` go through `connector.apply()`.
- The pipeline uses `warehouse.processing_jobs` for job management with `claim_next_job` RPC and `schedule_retry()` for exponential backoff (1 min / 5 min / 25 min).

## Code conventions

- TypeScript strict mode everywhere
- German-language UI, English-language code and documentation
- shadcn/ui for UI components (`src/components/ui/`)
- Tailwind for styling
- All SQL in migration files — never inline schema changes
- New warehouse features: add migration to `supabase/migrations/`
- New public schema changes: update `prisma/schema.prisma` and run `prisma migrate`

## File structure

```
src/
  app/           → Next.js pages and API routes
  components/    → React components, organized by domain
  lib/           → Server actions, DB clients, utilities
  tests/         → Test files and fixtures

supabase/
  functions/     → Edge Functions (process-document, inbound-email, telegram-bot)
  migrations/    → Incremental SQL migrations

migrations/      → Bootstrap SQL (01_shared, 02_warehouse, 03_pm_and_connector, 04_storage_and_jobs)
prisma/          → Prisma schema and config
scripts/         → Utility scripts (seed, backfill, debug)
```

## RLS

All `warehouse.*` and `pm.*` tables have row-level security with org isolation via `shared.current_org_id()`. Every query through the Supabase client automatically scopes to the current user's org. Do not bypass RLS unless using the service role key for administrative operations.

## Testing

- Unit tests go in `src/tests/`
- Golden file fixtures go in `src/tests/fixtures/`
- Test pipeline steps with mocked AI responses (don't call Claude in unit tests)
- Golden file tests call the real pipeline and compare against expected output
