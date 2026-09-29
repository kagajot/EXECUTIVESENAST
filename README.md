# PEO Assistive Matcher (draft v0.1)

Matches a person with physical / cognitive limitations to **assistive tools and everyday workarounds**, using the
Person-Environment-Occupation (PEO) model. Goal is **compensation and adaptation**, not rehabilitation, fitness or wellness.

> **Status: engineering draft. Every seed catalogue entry is `safety_review.status = "draft"`.** With production
> defaults (`requireClinicalReview: true`) the engine therefore recommends nothing. Demo/tests pass
> `requireClinicalReview: false`. Thresholds, contraindications and evidence tiers in `data/tools.seed.json` are
> **illustrative placeholders written by an engineer, not clinical guidance**. They need review by a qualified OT
> before any real user sees a recommendation.

## Design philosophy (from the Headspace-style reference)

The reference UI is a search bar, a row of quick-filter chips, and colour-coded category cards. We keep that
*browse* pattern because it is low-cognitive-load, but invert who decides what appears:

| UI element (reference)     | Role here                                            | Safety rule                                                                    |
|----------------------------|------------------------------------------------------|--------------------------------------------------------------------------------|
| Category cards             | `taxonomy.categories` (colour token, sort order)     | A card exists only if >=1 tool survived the gates. Empty categories are hidden. |
| Quick chips                | `tools[].tags` -> `taxonomy.chips`, counted per result | Counts are computed from survivors only.                                       |
| Search bar                 | `occupation.query.text` over name/summary/tags/task  | Runs **after** gating. Cannot add tools.                                       |
| "Featured" card            | Top-N ranked survivors                               | Never a promoted / sponsored slot.                                             |
| Streaks, mood, progress    | **Not used**                                         | Wellness/fitness mechanics are out of scope.                                   |

## Files

| Path                             | Purpose                                                                    |
|----------------------------------|----------------------------------------------------------------------------|
| `data/taxonomy.json`             | Controlled vocabulary: 19 capacity dimensions, risk flags, env/tech tags, categories, chips, tasks |
| `schema/tool.schema.json`        | JSON Schema (draft-07) for a catalogue entry                               |
| `schema/profile.schema.json`     | JSON Schema for a PEO profile                                              |
| `data/tools.seed.json`           | 18 seed tools / workarounds (draft, unreviewed)                            |
| `examples/profiles.json`         | 3 example profiles incl. one deliberately incomplete intake                |
| `src/engine.mjs`                 | Gates, ranking, browse view, assessment gaps                               |
| `src/validate.mjs`               | Vocabulary validation (unknown tag = hard error)                           |
| `test/*.test.mjs`                | 22 tests incl. a 3000-profile fuzz test against an independent oracle      |

## The app (`demo/`)

`node demo/build.mjs` builds `demo/peo-matcher.html`: a single-file mobile-style app that inlines the real engine.
First run is a setup flow that only asks what the chosen goals make relevant (about 12 of 19 ability questions for
a two-goal example). Answers are saved in the browser's `localStorage` on that device only; nothing is sent anywhere.
Features: safe-options browse (category cards, chips, search), tool detail with why-it-fits, a saved toolkit that is
re-checked against the current answers, the Safety tab listing every excluded tool with its reason and one-tap
questions that could unlock more, and a copyable summary for a therapist. It is free: no accounts, no paywall.
The catalogue is still unreviewed drafts, and the UI says so.

Run: `npm test`, `node src/cli.mjs post_stroke_left_hemiparesis --allow-draft`

## Data model

**Person** - `capacities`: 19 dimensions on an ordinal 0-4 scale (0 unable, 4 typical), `null`/absent = *not assessed*;
`risk_flags`; `risk_screening_complete` (explicit boolean, required); `tech_literacy` (tags the person demonstrably holds);
`budget_band`; `preferences.prefer_low_tech`.

**Environment** - `confirmed_tags` only. A tag never asked is simply absent, and absence means *not supported*.

**Occupation** - `goals` (task ids), optional UI `query`. Empty goals = browse mode.

**Tool** - `demands` (min capacity per dimension, optionally `critical`), `hazards.severity`, `contraindicated_if_any`,
`supervised_if_below`, `environment.requires_all` / `forbids_any`, `tech.daily_use` / `tech.setup`,
`setup_requires_helper`, `cost_band`, `complexity`, `learning_burden`, `evidence`, `safety_review`.

## Algorithm

```
validate(catalogue, profile)                     # unknown vocabulary => throw
relevant  = tools addressing any goal            # (all tools in browse mode)
for tool in relevant:
    failures = gates(tool, profile)              # ALL gates evaluated, none short-circuit (full audit trail)
    eligible if failures == []
narrow eligible by query.category / chips / text # can only remove
rank eligible by weighted score                  # cannot rescue an excluded tool
build browse view from survivors
rank unanswered questions by tools they could unlock
```

| Gate | Fails when                                                                                   | Kind        |
|------|----------------------------------------------------------------------------------------------|-------------|
| G0   | entry is not `clinician_reviewed` (when `requireClinicalReview`)                             | hard        |
| G1   | tool has contraindications or moderate/high hazard AND `risk_screening_complete != true`     | unconfirmed |
| G2   | any person risk flag is in `contraindicated_if_any`                                          | hard        |
| G3   | capacity `null`/absent for a demanded dimension                                              | unconfirmed |
| G3   | capacity < `min` (+1 margin on `critical` dims when hazard severity is `high`, capped at 4)  | hard        |
| G4   | capacity < `supervised_if_below.level` and `caregiver_present_during_use` not confirmed      | hard        |
| G5   | any `requires_all` env tag not explicitly confirmed                                          | unconfirmed |
| G5   | any `forbids_any` env tag present                                                            | hard        |
| G6   | `setup_requires_helper` and no helper; setup tech missing and no helper; **daily-use tech missing (never delegable)** | unconfirmed |
| G7   | `cost_band` > `budget_band` (preference, not safety)                                         | preference  |

Every excluded tool is returned with all its failure codes. `unconfirmed` failures feed `assessment_gaps`
("answer this question and N more tools become eligible"); only tools with **no** hard failure are counted, so we never ask
a question whose answer cannot change the outcome. Answering may still reveal a hard failure - the tool is never
recommended on the assumption that it will pass.

**Ranking** (survivors only): `0.25 headroom + 0.25 goal coverage + 0.20 simplicity + 0.15 hazard + 0.10 evidence + 0.05 cost`.
`prefer_low_tech` moves 0.10 from headroom to simplicity. Simplicity encodes least-complex-solution-first. **These
weights are unvalidated engineering guesses.** They affect order only, never eligibility.

## Invariants (tested)

1. A tool is recommended only if it passes every gate; query, category, chip and rank cannot add one (fuzz + oracle).
2. Fail-closed: unknown capacity, unconfirmed environment/tech, incomplete screening all exclude.
3. No override or "show anyway" path exists in the API.
4. Typos in safety vocabulary (risk flags, env tags) throw instead of silently disabling a filter.
5. Deterministic output. Verified by mutation: disabling any single gate makes >=2 tests fail.

## Known limitations

- Capacity scores are ordinal and, in practice, mostly self- or carer-reported. Garbage in, garbage out: the engine
  cannot detect an over-optimistic profile. A validated assessor-completed intake is required for real use.
- Gating is deterministic thresholds. It cannot represent interactions (e.g. a tool safe with either good balance *or* a
  caregiver) beyond `supervised_if_below`. Extend the schema before adding such tools rather than approximating.
- Environment gating is only as good as the tag set; a hazard with no tag is invisible to the engine.
- Fluctuating conditions (e.g. MS, Parkinson's on/off) are modelled as a single "bad-day" capacity, which is conservative but crude.
- Not a medical device; regulatory status (e.g. SaMD classification) has not been assessed.
