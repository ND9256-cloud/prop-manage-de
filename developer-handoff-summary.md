# PropManager DE — Developer Handoff Summary
## Updated May 3, 2026 (post Tier 0 completion)

---

## What This System Is

A German property management document warehouse SaaS that ingests, classifies, extracts, and understands documents using AI. Two properties loaded with 634 real documents, fully processed and manually reviewed. Five foundational integrity gates shipped and enforced via CI.

**Live URL:** https://prop-manage-de.vercel.app
**Repo:** github.com/ND9256-cloud/prop-manage-de
**Stack:** Next.js App Router, Tailwind v4, shadcn/ui, Prisma, Supabase, NextAuth v5, Vercel
**Infrastructure:** Mac Mini M4 (Tailscale), Discord control plane, pg_cron auto-processing

---

## What Changed Since March 2026

### Synthetic Monitoring (April 2026)
Built and live. Two-tier system: HTTP ping every 5 min (Tier A) + Playwright login every 15 min (Tier B). Alerts to Discord #pipeline with typed color-coded embeds. Connectivity self-check suppresses false alarms when Mac Mini's internet drops. Heartbeat deadman detects if the monitor itself dies. DOM contract `data-testid="warehouse-properties-loaded"` on /dashboard/warehouse is an invariant — any redesign must preserve it.

### Typed Notification System (April 2026)
Discord notifications redesigned. JSON schema with validation: each notification has type, title, summary, structured fields, action links. Types include task_completed, task_failed, synthetic_failure, synthetic_recovery, and more. Orchestrator auto-injects `### SUMMARY:` into Claude Code tasks so completions show readable summaries instead of transcript dumps.

### Tier 0 Foundational Integrity Gates (May 2026)
Five gates, all shipped and enforced:

1. **Multi-tenant CI gate** — lint on every PR that catches Prisma queries missing org_id filter. 13 models annotated. Branch protection active.
2. **Migration discipline** — Supabase CLI linked, 26 migrations tracked. `supabase db push` only, no manual SQL. CI drift detection on PRs.
3. **ARCHITECTURE_STATE.md CI gate** — PRs touching key code paths must update the state file or build fails.
4. **GoBD soft-delete + retention** — Documents can't be hard-deleted (Postgres trigger). Retention periods enforced before soft-delete allowed. Audit trail with deleted_at + deleted_by.
5. **Backup-restore drill** — Passed. 4.7MB dump, restored to separate project, all 634 docs + 402 intelligence rows verified. Quarterly cadence.

### Cost Classification (April 2026)
cost_class + umlagefaehig columns on document_intelligence. Pipeline auto-classifies new docs. Betriebskosten split tracked.

---

## How to Make Changes

1. Read ARCHITECTURE_STATE.md first — it's the source of truth
2. Send task to Discord #nils: `!claude !t1 [simple] or !t2 [complex] [description]`
3. Claude Code executes on Mac Mini, commits, pushes
4. Vercel auto-deploys from main
5. Three CI gates run on every PR: tenant isolation, migration drift, architecture state
6. Update ARCHITECTURE_STATE.md after architectural changes (CI enforces this)

---

## Current Status

**Ready for customer #1.** All five Tier 0 gates are shipped. No technical blockers remain. The system has automated defense against cross-tenant leaks, tracked migrations, enforced source-of-truth documentation, GoBD-compliant document retention, and proven backup recovery.
