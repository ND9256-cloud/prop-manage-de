
## 2026-05-31 — Phase 4 eval-hardening track CLOSED
Shipped + merged: 4.2a (DB-free eval tests run in CI on every PR, eval-tests job), 4.2b (score skips fixtures with no candidate — killed the misleading 0.96 aggregate), 4.2c (--fixture-id substring targeting, both modes, zero-match exits non-zero).
First clean Lena baseline (via `score --fixture-id everding`): norm=1.000, exact=0.875, evid=0.625.
NEXT: Task 4.3 gold set — plan in docs/tasks/task-4.3-plan.md. Two findings: (1) one source.txt per gold envelope (multi-envelope dirs score garbage); (2) evidence-grounding metric is broken (verbatim-quote-in-OCR fails on gold's own quotes) — redefine value-anchored/token-overlap + add gold-self-grounding invariant. evid must NOT gate CI until redefined.
PENDING SECURITY: rotate Discord bot token + Supabase DB password (both exposed plaintext).
LESSON: any task touching .github/workflows, migrations, process-document, *-actions.ts, src/app, prisma schema, or tenant-isolation-lint MUST add an ARCHITECTURE_STATE.md line (gate fires otherwise).
