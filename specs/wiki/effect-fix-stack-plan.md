# Effect fix stack plan

Created 2026-11-21. Executes the six selected findings from
[effect-audit-2026-11-21](effect-audit-2026-11-21.md) as a linear stack of PRs against
`main`, ordered by what must merge first. All implementation happens in a dedicated
worktree (`effect-audit-fixes`), one subagent per PR, sequentially — each branch is cut
from the previous PR's branch.

Merge order rationale (2026-11-21):

- **1 first**: standalone live bug, touches only `tesla-client/`, zero overlap with the rest.
- **9 before 3**: finding 3 implements a method in the adapter file finding 9 rewrites;
  implementing on the old shape wastes work.
- **4 before 7**: both reshape app.ts/session-lifecycle; 4 settles service interfaces
  (`get()` → Effect) that 7's scope work must call.
- **11 last**: honest test layers must encode the final service shapes produced by 1–9.

## Stack status

Live state of the stack. Update this table as PRs land. Claims below are dated.

| # | Branch | Finding | Base | State (as of) | PR |
|---|---|---|---|---|---|
| 1 | `fix/token-refresh-recurring` | 1 | `main` | PR #16 merged by owner (2026-11-21) | [#16](https://github.com/ojhaujjwal/tesla-charger/pull/16) |
| 2 | `refactor/data-adapter-effect` | 9 | `main` (auto-retargeted after #16 merged) | PR #17 open, verified, ready (2026-11-21) | [#17](https://github.com/ojhaujjwal/tesla-charger/pull/17) |
| 3 | `fix/lowest-value-window` | 3 | `refactor/data-adapter-effect` | PR #18 open, verified, ready (2026-11-21) | [#18](https://github.com/ojhaujjwal/tesla-charger/pull/18) |
| 4 | `refactor/service-state-to-ref` | 4 | `fix/lowest-value-window` | PR #20 open, verified, ready (2026-11-21) | [#20](https://github.com/ojhaujjwal/tesla-charger/pull/20) |
| 5 | `refactor/app-session-scopes` | 7 | `refactor/service-state-to-ref` | PR #21 open, verified, ready (2026-11-21) | [#21](https://github.com/ojhaujjwal/tesla-charger/pull/21) |
| 6 | `refactor/effect-test-strategy` | 11 | `refactor/app-session-scopes` | PR #22 open, verified, ready (2026-11-21) — series complete | [#22](https://github.com/ojhaujjwal/tesla-charger/pull/22) |
| 7 | `fix/solcast-file-cache-encoding` | live bug (post-audit) | `refactor/effect-test-strategy` | PR #24 open, verified, ready (2026-11-21) | [#24](https://github.com/ojhaujjwal/tesla-charger/pull/24) |

## Per-PR scope boundaries

Hard boundaries to keep each PR reviewable and avoid racing findings deliberately left out
of the stack (see audit page "NOT in the stack"). If an agent believes a boundary is wrong,
it reports back instead of expanding scope.

1. **PR1 (finding 1)**: `tesla-client` refresh schedule + its call site in
   `session-lifecycle.ts` only. Do not touch unrelated retry logic.
2. **PR2 (finding 9)**: both data adapters → closure/`Effect.fn` layers, layer-level
   service provision, `Crypto` service. `DataAdapter` interface unchanged. The
   `Effect.die` calls (finding 2) stay as-is.
3. **PR3 (finding 3)**: implement or port-split `getLowestValueInLastXMinutes` based on
   what the Alpha ESS API actually supports. Update the test that asserts failure.
4. **PR4 (finding 4)**: `battery-state-manager`, `solcast.adapter`,
   `excess-solar-non-aggresive.controller`, `weather-aware-buffer/index`,
   `http/state.ts`, `application/charging-session.ts` + affected mocks. `get()` → Effect.
   Do not change `start(pubSub)` signatures (finding 6). Do not fix the
   `Option.getOrThrow` defect issue (finding 2) beyond lines already being rewritten.
5. **PR5 (finding 7)**: app.ts + session-lifecycle fiber/scopes/drain. `App` interface and
   `AppLayer` signature stable. Do not restructure parameter drilling (finding 6).
   Do not follow the stale `specs/pending/refactor-app-ddd.md` sketch.
6. **PR6 (finding 11)**: test strategy — `layerTest`/`layerMemory` for real seams,
   `it.scoped`/`layer()` in app.test.ts, new TestClock tests unlocked by PR4.

## Operational rules for implementing agents

- Working directory is the `effect-audit-fixes` worktree (given per-dispatch). The
  worktree is a fresh checkout: **run `HUSKY=0 npm install` first** (not `npm ci` — at
  `8e840cab` the lockfile is out of sync with `package.json`, and repo CI uses
  `npm install`), and confirm `npm run ci` is green on the base branch before changing
  anything. Do not regenerate the lockfile. `remote.pushDefault origin` is already set
  in the worktree's local git config; leave it alone.
- Comment policy (owner directive, 2026-11-21): **code is the source of truth.** No
  narrative comments, section banners, or comments restating what code does. Write a
  comment only for something implicit or unobvious — a *why*, a non-obvious invariant, an
  external-API quirk. Consistent with `repos/effect/LLMS.md`'s own note that comments in
  its examples are illustrative only.
- Read before coding (absolute paths, from the main checkout):
  `/Users/uo/Projects/tesla-charger/AGENTS.md`, `repos/effect/LLMS.md`,
  `specs/guides/testing-with-effect.md`, this wiki's audit page. Never use `bun test`;
  tests run via `npm run test -- --run`; the full gate is `npm run ci`. Note:
  `npm run test -- --run <path>` still runs the FULL `src/` suite — the script hardcodes
  `src/` (observed 2026-11-21, PR7 agent). Accept full-suite runs or invoke vitest
  directly; don't trust path filtering through the npm script.
- Bugs are reproduced test-first (red → fix → green) with `TestClock` where time is
  involved. Refactor PRs still add characterization tests pinning the new behavior.
- Conventional commits; one logical commit series per PR; minimal diffs; no drive-by
  formatting of unrelated files.
- Stacked PRs are created and managed with the `gh stack` extension (owner directive,
  2026-11-21), NOT per-PR `gh pr create`:
  - PR1's agent: `gh stack init <branch>` (bottom layer, trunk `main`) → work →
    `gh stack submit --auto` → set real title/body via `gh pr edit <n> --title ...
    --body-file <file>` (get `<n>` from `gh pr view --json number --head <branch>`).
  - PRn's agent (n>1): `gh stack add <branch>` (creates the branch on top of the current
    stack and checks it out) → work → `gh stack submit --auto` → `gh pr edit` body.
  - `gh stack submit --auto` creates drafts; leave them draft. The stack coordinator marks
    each PR ready after verification.
  - Observed 2026-11-21 (PR4 agent): this `gh` version lacks `gh pr view --head`; use the
    positional form instead: `gh pr view <branch-name> --json number,url`.
  - Note (2026-11-21): stack metadata may live in shared git config; the user's main
    checkout on `main` is unaffected but `gh stack view` there may show this stack.
  - Observed 2026-11-21: when a bottom PR merges, `gh stack submit` automatically skips
    the merged branch and retargets the next PR to `main`. Agents: let submit handle it;
    do not force bases manually.
- PR bodies follow the owner's `/pr` skill template (directive 2026-11-21):
  `## Summary` (smallest visual that makes the point: diff-sketch, call tree, or
  pseudocode), `## Evidence` (Before: failing test / After: passing test, by name),
  `## Merge Danger` (Door: one-way or two-way; Blast Radius: one word + short note).
  Brief prose. Final line notes stack position ("PR n/6 of the effect-philosophy stack").
- Do not write anything into `specs/pending/` — it is the Ralph loop's queue.
- Report back: PR URL, commit range, tests added, deviations, surprises.

## Retro log

One-in-five subagent sessions get a retro (per chief-of-staff). Entries appended below as
they happen.

- 2026-11-21: PR1 dispatch #1 died at spawn — the default subagent model (`mimo-v2.5`) is
  rejected by the runtime as deprecated, even though the models listing shows it "active".
  Learning: **every subagent dispatch must pin an explicit model.** On 2026-11-21 the owner
  chose `opencode-go/deepseek-v4.1-flash` for all subagents in this stack. No work was
  lost; re-dispatched with the model pinned.
- 2026-11-21 (retro, session 1 — PR1, completed cleanly; friction worth capturing):
  - Environment: `npm ci` fails at the `8e840cab` baseline — `package-lock.json` is out of
    sync with `package.json` (repo CI itself uses `npm install`). Agents must use
    `HUSKY=0 npm install`. The lockfile desync is a repo-level latent issue surfaced to
    the owner; deliberately NOT fixed inside this stack. The worktree has
    `remote.pushDefault origin` set locally (two remotes: origin + bitbucket) — do not
    remove it.
  - Test-infra pattern worth reusing (PR4/PR6 will need it): synchronous
    `FileSystem.layerNoop` + one `Effect.yieldNow` after forking makes TestClock daemon
    tests deterministic.
  - Process: reproduce-first, scoped diffs, /pr template, and the gh-stack flow all held
    up on the first real session; baked into all subsequent dispatches.
  - The chief-of-staff retro procedure (`../retro/SKILL.md`) is referenced by the skill
    but not installed on this machine; this retro ran manually. Installing it is an
    environment-improvement candidate for the owner.
- 2026-11-21 (series retro — all 6 sessions complete):
  - Corrected assumption: `@effect/vitest` 4.1.5 has NO `it.scoped` and no guide-style
    `layerTest`; `it.effect` is already `Effect.scoped` + TestEnv
    (`@effect/vitest/dist/internal/internal.js:262`), and `layer()` (incl. `buildPerTest`)
    exists but nothing was genuinely shareable. Learning: agents must check the INSTALLED
    test API (node_modules / vendored source) before designing test layers — audit
    assumptions are not API facts.
  - Audit blind spot surfaced by characterization testing: solcast writes its file cache
    after decoding (`period` → Duration object) but `FileCacheSchema` decodes `period` as
    the ISO string — a cache the adapter wrote itself never loads back. The 2026-11-21
    audit flagged the adjacent `Option.getOrThrow` defect but missed this; tests found
    what the audit could not. Recorded as a live production bug (see audit page).
  - What held across all six sessions: scope fencing (zero out-of-scope files landed),
    reproduce-first (caught the `Schedule.duration` and PubSub semantics), the /pr body
    template, gh-stack auto-collapse on merge, and the comment policy.
  - Candidates for the owner (not auto-pursued): the solcast cache fix, lockfile
    resync, installing the retro skill, weather-aware test dedup.
- 2026-11-21 (formal retro via the installed `retro` skill — target: the PR6 session;
  sources: PR6 agent report, PR #22 body+diff, shipped fixtures, dispatch prompt;
  subagent transcripts are not persisted to local storage — noted limitation):
  - Candidate 1 (pursuing): `specs/guides/testing-with-effect.md` teaches `it.scoped`,
    which does not exist in `@effect/vitest` 4.1.5 — `it.effect` is already
    `Effect.scoped` + TestEnv (`dist/internal/internal.js:262`). The project's own
    guide misleads every reader; PR6 paid investigation cost to disprove it. →
    PR #25, verified ready 2026-11-21.
  - Candidate 2 (pursuing): `AGENTS.md` steers tests via `bun run test --run` in an
    npm/vitest repo — contradiction plus no-op (bun is not used anywhere). → fixed in
    PR #25: the line now states the positive target (`npm run test -- --run`).
  - Candidate 3 (pursuing): no repo-tracked `CODING_STANDARDS.md` — the series'
    review-time rules (comment policy, defects-only-for-programmer-error, scope
    fencing, reproduce-first, no-new-deps) live only in dispatch prompts and the
    untracked wiki; the reviewer stage cannot enforce what it cannot read. →
    PR #26 (31 lines), verified ready 2026-11-21. Its `specs/wiki/` pointer goes live
    once the wiki-commit PR merges.
  - Candidate 4 (user-only): stale `specs/pending/` entries (`refactor-app-ddd.md`
    describes a 461-line app.ts that no longer exists; the checked-off
    effect-gen-to-fn spec still sits in pending). Ralph automation may re-implement
    them. Only the owner moves specs, per `specs/README.md`.
  - Candidate 5 (already being fixed): lockfile desync silently breaking `npm ci` at
    clean checkouts — closed by PR #23, **merged by owner** 2026-11-21: `npm ci` passes
    (285 packages) with live before-failure evidence captured at `107d0868`. Root
    cause: the effect v4.1.5 upgrade (#15) left the lockfile pinning beta.66.
  - Candidate 6 (recorded, no repo action): the models API lists deprecated models as
    active; dispatch prompts must keep pinning models explicitly.
