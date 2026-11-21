# specs/wiki/

Durable knowledge for the tesla-charger project. Unlike `specs/pending/`, nothing here is
automation-triggering — the Ralph loop does not read this directory.

Conventions:

- Every claim is dated and pinned to a commit. Nothing here describes "now".
- Pages are history: when code changes, add a new dated claim and mark the old one superseded.
- Sources (audit transcripts, PRs, subagent reports) are cited, never copied in.

## Pages

### Audits

- [effect-audit-2026-11-21](effect-audit-2026-11-21.md) — Full Effect philosophy audit of the
  codebase at `8e840cab`. Eleven findings (4×P0, 7×P1/P2) with file:line evidence. Six were
  selected for a stacked-PR fix series.

### Plans

- [effect-fix-stack-plan](effect-fix-stack-plan.md) — The 6-PR stack fixing audit findings
  1, 3, 4, 7, 9, 11: merge order, per-PR scope boundaries, operational rules for
  implementing agents, and live PR status.

### Tribal knowledge

- [stale-specs](stale-specs.md) — Which `specs/pending/` entries describe a codebase that no
  longer exists, and what that means for agents that cite them.
- [pubsub-shutdown-semantics](pubsub-shutdown-semantics.md) — What effect's
  `PubSub.shutdown` really does (drops un-pulled messages, interrupts pending takes, no
  drain, no ack API) and how tesla-charger drains deterministically. Pinned to vendored
  effect 4.1.5.
