# T007 — Deliver job tailoring and independent language variants

**Task:** T007 · **PR size:** L · **Branch:** `feat/t007-job-language-variants`
**Depends on:** T006 · **Priority:** 70
**Status:** Proposed implementation plan, 2026-11-03; owner review required. No release approval is asserted.
**Scheduling:** [Task Graph](../tasks.md#task-graph) is the only completion authority; keep [ ] until the PR is first shipped (owner decision 2026-11-14).

## Goal

Deliver exact-version job evidence and independently reviewed Arabic/English variants without mutating confirmed
master facts.

## Scope (in)

- Preserve one base-CV slot across its language versions, job-tailored copies and revisions.
  Consume T005 usage preflight before AI; Start must demonstrate its included language version and tailored copy.

- Own B-C06 deterministic coverage of a selected CV and exact pasted job, with matched/unmatched terms, denominator,
  normalization and passages.
- Optional approved AI maps supported/partial/no evidence/unclear findings to cited CV facts and job spans, proposing
  changes for acceptance.
- Own B-C09 reviewed translation/language variants, terminology correction, names/meaning/date preservation and
  separate freshness.
- Create tailored variants intentionally through reviewed patches; never overwrite the master or another language to
  raise coverage.
- Publish job evidence to T004's third result; no job means not checked and job-only changes do not invalidate
  unchanged PDF checks.
- Own A03 evidence evaluations including absent/ambiguous requirements and repeated semantic runs where enabled.

## Explicit exclusions

- No hiring probability, universal ATS score, unsupported skill insertion, automatic application or employer decision
  system.
- No interface switch that translates saved content, unapproved job scraping or new external integration.

## Requirement IDs

**Owns:** B-C06, B-C09, A03.
**Consumes / contributes:** B-C04, B-C05, B-C07, B-O03, A02, A04, A06, A07, A08, A11, A13.
Ownership includes evidence coordination; consumers must still meet applicable gates. Deferred requirements remain
deferred.

## Figma targets

- Own S19 Target a job, S20 Job evidence including all requirements, and S21 Language versions including reviewing
  translation.
- Use Edit English term; consume S08 tailored copy/English document, S10/S12 evidence and S22 history.
- Inspect missing job, pending/failed/partial analysis, unclear evidence and stale translation/proposal recovery.
- Resolve current masters, product states and named dialogs in [figma-map.json](../../context/design/figma-map.json).
  Never hard-code node IDs in this brief. Verify target names and current renders using authorized access during
  implementation.
- Do not implement Popup Simulator/Note frames or infer application routes from prototype navigation.

Implement this inventory with existing shared components, the appropriate shared shell/container and T002 type/spacing/radius/control APIs; use AppShell/PageHeader for dashboard pages. Use Figma for elements, icons, content, order, dialogs and states; do not copy pixel geometry or create per-screen styles. Apply the D35 verification record to every changed target.

## Source references

- [business/requirements.md](../../context/business/requirements.md)
- [decisions.md](../../context/decisions.md)
- [technical/ai.md](../../context/technical/ai.md)
- [technical/architecture.md](../../context/technical/architecture.md)
- [technical/security.md](../../context/technical/security.md)
- [design/design-system.md](../../context/design/design-system.md)
- [design/figma-handoff.md](../../context/design/figma-handoff.md)

## Ownership boundaries

- `apps/web/src/features/career/`
- `apps/web/src/features/resume/editor/check/`
- `apps/web/src/features/resume/editor/proposals/`
- `apps/web/src/dialogs/resume/`
- `packages/resume/src/ats/`
- `packages/api/src/features/career/`
- `packages/api/src/features/ai/`
- `packages/ai/src/`
- `packages/schema/src/career.ts`
- `packages/db/src/schema/career.ts`
- `migrations/`
- These are existing repository paths, not permission to replace their contents. Coordinate shared schemas,
  migrations,
  routes, environment definitions, package exports and lockfile changes with their task owners.
- Retain `apps/mobile/` and validate affected shared packages; native-store delivery is outside this web roadmap.

## Implementation notes

- Reuse job matching, career data and T005/T006 runtime/proposals. Store exact CV/job revisions and normalization
  policy instead of unexplained match percentages.
- Literal coverage measures words, not ability or hiring chances; missing text is not proof of missing ability. State
  unknown destination Arabic parser support unless verified.
- Explain synonym matching and minimize semantic inputs. Never silently convert calendars or propagate translated
  edits across variants.
- Interface switching preserves active document language, selected job, revisions and reviewed wording.
- T004 owns panel rendering/invalidation and T001 extraction qualification; coordinate evidence/report schemas without
  duplicating engines.
- Reuse the existing Reactive Resume React/Vite/TanStack Router, Hono, Better Auth and shared package conventions.
  No framework rewrite, second app, parallel UI library or unnecessary dependency upgrade.
- Use `Planning/context/design/copy-deck.json` as the English UI copy source, owned by T002; each feature adds its
  keys
  to that deck and existing runtime catalogs. Interface language never translates or overwrites saved CV content.

## Acceptance evidence

D36 job page changes, owner decision 2026-11-26 (B-C04, B-C06, B-C07, and B-C09).
See [the Figma map](../../context/design/figma-map.json) for S19 and S20 desktop and mobile masters.
The review covers the start, all requirements, question answered, and fact recorded states.

- The context bar keeps the selected CV and job together so that users can see what they are comparing.
- The keyword panel shows missing terms first and folds each group after six terms so that users can scan the gaps.
- The tailoring card shows one primary action at each step and keeps approval per edit so that users control what the copy contains.
- The beta section folds detailed checks and summarizes unchecked requirements so that users see recovery actions without reading unverified claims.

A read-only replay found four broad absence claims, three unsupported importance labels, and one unsupported claim.
The offline replay withheld 4 of 16 after it reused recorded absence checks with scoped wording. The original held 8 of 16.
Two responses finished after a retry because the first responses were incomplete. The replay made no paid calls.
Evidence includes 26 matcher tests, 2,021 web tests, the API suite, and five browser states in Arabic and English at 1440 and 390 pixels.

D36 translation review changes, owner decision 2026-11-26 (B-C05, B-C09 and A13). See
[the Figma map](../../context/design/figma-map.json) for the S21 masters, translation review, term dialog, and mobile term sheet.
The owner-approved wireframes guide the redesign. Live Figma access was unavailable.

- The overview uses two cards and opens review in place so that saved copies and draft actions stay distinct.
- The review uses one approval action because the user approves the full document.
- The warning folds the untranslated detail so that the user can read the translated sections first.
- The mobile actions stay above the dashboard tabs so that the save and discard controls stay within reach.
- The term dialog and retry consent retain their existing approval steps and recovery behavior.

Local evidence uses synthetic CVs and a disposable database. The API and web suites passed.
Chromium captured the overview, progress, review and mobile actions in Arabic and English at 1440×900 and 390×844.
Impeccable reported one warning for the shared T002 page background.

- Test exact-version binding, deterministic normalization/denominators, unsupported skills, absent evidence and
  job-only versus CV-change invalidation.
- Verify AR-interface/EN-document and EN-interface/AR-document, proper nouns, mixed-script skills, reviewed
  terminology, stale variants and persistence.
- Test accept/edit/reject/undo, owner/base checks and repeated optional AI source mapping/unsupported claims.
- A03 is the owning gate; A02/A04/A06/A07/A08/A11/A13 still apply. No local result certifies a named ATS.
- ALWAYS check Arabic RTL and English LTR at desktop 1440 and mobile 390, with the correct loaded fonts and direction.
  For non-UI work, exercise the affected consumer journey; document any unavailable browser/visual evidence as
  blocked.
- Record tested commit, commands/results, fixtures, browser artifacts and unresolved gates. Test real state and
  services;
  distinguish synthetic doubles, sandbox checks, document viewers and production evidence. This brief passes no A
  gate.

## Open approvals/blockers affecting the task

- D08/D22 working evidence-bearing assessments require implementation/release evidence, never universal scoring.
- D16/A11 gates semantic processing; D23 does not authorize public analysis exposure.

## Done definition

- The scoped implementation and recovery paths meet the stated acceptance evidence, with no fabricated completion.
- Requirement/screen ownership, source conflicts, unsupported cases and external approvals are recorded honestly.
- Required checks/reviews pass for the proposed merge scope; unresolved release gates remain explicit and disabled.
- Update the single graph status and Mermaid class when its PR is first shipped (owner decision 2026-11-14), preserving all 16 large PRs.
