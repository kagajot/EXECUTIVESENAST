// PEO matching engine: Person x Environment x Occupation -> assistive tools / workarounds.
//
// Pipeline:  validate -> relevance -> HARD GATES -> query filter -> rank -> browse view
//
// Invariants (enforced by test/invariants.test.mjs):
//   I1  A tool is recommended only if it passes EVERY gate. Ranking, categories, chips and
//       search can only remove candidates, never add or rescue one.
//   I2  Fail-closed: an unassessed capacity, an unconfirmed environment/tech tag or an
//       incomplete risk screening is treated as a failure, never as a pass.
//   I3  The engine has no "override", "relax" or "show anyway" path.
//
// Purpose is compensation / adaptation. Nothing here scores or suggests rehabilitation.

import { validateCatalog, validateProfile, normalizeDemand } from './validate.mjs';

export const ENGINE_VERSION = '0.1.0';

export const DEFAULTS = Object.freeze({
  // Production must keep this true: draft (unreviewed) catalogue entries are not recommended.
  requireClinicalReview: true,
  // Extra capacity margin demanded on `critical` dimensions, by hazard severity.
  safetyMargin: { none: 0, low: 0, moderate: 0, high: 1 },
  enforceBudget: true,
  featuredN: 3,
});

// Failure kinds:
//   hard        - person/environment demonstrably cannot support the tool. Never recoverable by asking more.
//   unconfirmed - we lack information. Still excluded; answering the question may make it eligible.
//   preference  - not a safety issue (budget).
const F = (gate, code, kind, detail, extra = {}) => ({ gate, code, kind, detail, ...extra });

// ---------------------------------------------------------------- gates

export function evaluateGates(tool, profile, opts = DEFAULTS) {
  const { person, environment } = profile;
  const caps = person.capacities ?? {};
  const envTags = new Set(environment.confirmed_tags ?? []);
  const techTags = new Set(person.tech_literacy ?? []);
  const riskFlags = new Set(person.risk_flags ?? []);
  const sev = tool.hazards.severity;
  const fails = [];

  // G0 clinical review
  if (opts.requireClinicalReview && tool.safety_review?.status !== 'clinician_reviewed') {
    fails.push(F('G0_REVIEW', 'REVIEW_REQUIRED', 'hard', 'Catalogue entry has not been clinician-reviewed'));
  }

  // G1 risk screening must be complete before anything with a contraindication list or real hazard
  const needsScreen = (tool.contraindicated_if_any?.length ?? 0) > 0 || sev === 'moderate' || sev === 'high';
  if (needsScreen && !person.risk_screening_complete) {
    fails.push(F('G1_SCREENING', 'SCREENING_INCOMPLETE', 'unconfirmed', 'Risk-flag screening not completed'));
  }

  // G2 contraindications
  for (const flag of tool.contraindicated_if_any ?? []) {
    if (riskFlags.has(flag)) fails.push(F('G2_CONTRAINDICATION', 'CONTRAINDICATED', 'hard', `Contraindicated by risk flag: ${flag}`, { target: flag }));
  }

  // G3 capacity demands (physical / sensory / cognitive / communication)
  for (const [dim, raw] of Object.entries(tool.demands ?? {})) {
    const d = normalizeDemand(raw);
    const cap = caps[dim];
    if (cap === null || cap === undefined) {
      fails.push(F('G3_CAPACITY', 'CAPACITY_UNKNOWN', 'unconfirmed', `${dim} not assessed`, { target: dim }));
      continue;
    }
    const need = Math.min(4, d.min + (d.critical ? opts.safetyMargin[sev] ?? 0 : 0));
    if (cap < need) {
      fails.push(F('G3_CAPACITY', 'CAPACITY_BELOW_DEMAND', 'hard', `${dim} ${cap} < required ${need}${need > d.min ? ` (min ${d.min} + safety margin)` : ''}`, { target: dim, have: cap, need, min: d.min }));
    }
  }

  // G4 graded supervision: below the level, a person must be present during use
  let supervisedUse = false;
  for (const s of tool.supervised_if_below ?? []) {
    const cap = caps[s.dimension];
    if (cap === null || cap === undefined) {
      fails.push(F('G4_SUPERVISION', 'CAPACITY_UNKNOWN', 'unconfirmed', `${s.dimension} not assessed (needed to decide supervision)`, { target: s.dimension }));
    } else if (cap < s.level) {
      supervisedUse = true;
      if (!envTags.has('caregiver_present_during_use')) {
        fails.push(F('G4_SUPERVISION', 'SUPERVISION_UNAVAILABLE', 'hard', `${s.dimension} ${cap} < ${s.level}: someone must be present during use`, { target: 'caregiver_present_during_use' }));
      }
    }
  }

  // G5 environmental gating: requirements must be EXPLICITLY confirmed; hazards must be absent
  for (const tag of tool.environment?.requires_all ?? []) {
    if (!envTags.has(tag)) fails.push(F('G5_ENVIRONMENT', 'ENV_REQUIREMENT_UNCONFIRMED', 'unconfirmed', `Environment does not confirm: ${tag}`, { target: tag }));
  }
  for (const tag of tool.environment?.forbids_any ?? []) {
    if (envTags.has(tag)) fails.push(F('G5_ENVIRONMENT', 'ENV_FORBIDDEN_PRESENT', 'hard', `Environment has blocking condition: ${tag}`, { target: tag }));
  }

  // G6 setup support + tech literacy. Setup may be done by a helper; daily use may not.
  const helper = envTags.has('helper_available_for_setup');
  if (tool.setup_requires_helper && !helper) {
    fails.push(F('G6_TECH', 'SETUP_HELPER_UNAVAILABLE', 'unconfirmed', 'Needs installation/setup by another person', { target: 'helper_available_for_setup' }));
  }
  for (const tag of tool.tech?.setup ?? []) {
    if (!techTags.has(tag) && !helper) fails.push(F('G6_TECH', 'TECH_UNCONFIRMED', 'unconfirmed', `Setup needs "${tag}" or a setup helper`, { target: tag }));
  }
  for (const tag of tool.tech?.daily_use ?? []) {
    if (!techTags.has(tag)) fails.push(F('G6_TECH', 'TECH_UNCONFIRMED', 'unconfirmed', `Daily use needs "${tag}"`, { target: tag }));
  }

  // G7 budget (preference, not safety)
  if (opts.enforceBudget && person.budget_band !== undefined && tool.cost_band > person.budget_band) {
    fails.push(F('G7_BUDGET', 'BUDGET_EXCEEDED', 'preference', `Cost band ${tool.cost_band} > budget band ${person.budget_band}`));
  }

  return { failures: fails, supervisedUse };
}

// ---------------------------------------------------------------- ranking (survivors only)

const EVIDENCE = { unassessed: 0.2, manufacturer_claim_only: 0.3, expert_consensus: 0.6, clinical_guideline: 0.85, controlled_study: 1.0 };
const HAZARD = { none: 1, low: 0.9, moderate: 0.7, high: 0.5 };
export const WEIGHTS = Object.freeze({ headroom: 0.25, coverage: 0.25, simplicity: 0.20, hazard: 0.15, evidence: 0.10, cost: 0.05 });

function headroom(tool, caps) {
  const ds = Object.entries(tool.demands ?? {});
  if (!ds.length) return 1;
  const parts = ds.map(([dim, raw]) => {
    const { min } = normalizeDemand(raw);
    return min >= 4 ? 1 : Math.max(0, Math.min(1, (caps[dim] - min) / (4 - min)));
  });
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function simplicity(tool, caps) {
  // Least-complex-solution-first (standard OT practice): less complex, less setup, lighter learning.
  const cx = 1 - tool.complexity / 3;
  const nl = caps.new_learning;
  // Unknown learning capacity only affects ranking (safety is decided by gates), so be conservative.
  const learnFit = tool.learning_burden === 0 ? 1 : nl == null ? 0.4 : Math.max(0, Math.min(1, (nl - tool.learning_burden + 2) / 3));
  return 0.5 * cx + 0.5 * learnFit;
}

export function scoreTool(tool, profile, goals) {
  const caps = profile.person.capacities ?? {};
  const covered = goals.length ? tool.addresses.filter((a) => goals.includes(a)).length / goals.length : 1;
  const parts = {
    headroom: headroom(tool, caps),
    coverage: covered,
    simplicity: simplicity(tool, caps),
    hazard: HAZARD[tool.hazards.severity],
    evidence: EVIDENCE[tool.evidence] ?? 0.2,
    cost: 1 - tool.cost_band / 3,
  };
  const w = { ...WEIGHTS };
  if (profile.person.preferences?.prefer_low_tech) { w.simplicity += 0.10; w.headroom -= 0.10; }
  const score = Object.entries(w).reduce((s, [k, wt]) => s + wt * parts[k], 0);
  return { score: Math.round(score * 1000) / 1000, breakdown: parts };
}

// ---------------------------------------------------------------- main

export function recommend({ profile, tools, taxonomy, options = {} }) {
  const opts = { ...DEFAULTS, ...options, safetyMargin: { ...DEFAULTS.safetyMargin, ...(options.safetyMargin ?? {}) } };
  validateCatalog(tools, taxonomy);
  validateProfile(profile, taxonomy);

  const goals = profile.occupation.goals ?? [];
  const query = profile.occupation.query ?? {};
  const relevant = tools.filter((t) => !goals.length || t.addresses.some((a) => goals.includes(a)));

  const eligible = [], excluded = [];
  for (const tool of relevant) {
    const { failures, supervisedUse } = evaluateGates(tool, profile, opts);
    if (failures.length === 0) eligible.push({ tool, supervisedUse });
    else excluded.push({ tool_id: tool.id, name: tool.name, failures, could_unlock: failures.every((f) => f.kind === 'unconfirmed') });
  }

  // Query (category / chips / search) runs strictly AFTER gating: it can only narrow (I1).
  const text = (query.text ?? '').trim().toLowerCase();
  const inCategoryText = eligible.filter(({ tool }) => {
    if (query.category && tool.category !== query.category) return false;
    if (text) {
      const hay = [tool.name, tool.summary, ...tool.tags, ...tool.addresses.map((a) => taxonomy.tasks[a].label)].join(' ').toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
  const chipsWanted = query.chips ?? [];
  const shown = inCategoryText.filter(({ tool }) => chipsWanted.every((c) => tool.tags.includes(c)));

  const rank = (list) => list
    .map(({ tool, supervisedUse }) => {
      const s = scoreTool(tool, profile, goals);
      return {
        tool_id: tool.id, name: tool.name, kind: tool.kind, category: tool.category,
        addresses: tool.addresses.filter((a) => !goals.length || goals.includes(a)),
        score: s.score, breakdown: s.breakdown, summary: tool.summary,
        cautions: [
          ...(tool.hazards.notes ? [tool.hazards.notes] : []),
          ...(supervisedUse ? ['Use only with another person present.'] : []),
          ...(tool.setup_requires_helper ? ['Needs installation/setup by another person.'] : []),
        ],
        hazard_severity: tool.hazards.severity,
        review_status: tool.safety_review?.status ?? 'draft',
      };
    })
    .sort((a, b) => b.score - a.score || a.tool_id.localeCompare(b.tool_id));

  const recommendations = rank(shown);

  // Browse view (the category-card / chip / search UX). Built ONLY from survivors, so no card or chip
  // can lead to a disqualified tool; empty categories are omitted rather than shown "for browsing".
  const rankedCatText = rank(inCategoryText);
  const byCat = new Map();
  for (const r of rank(eligible.filter((e) => !query.category || e.tool.category === query.category))) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r.tool_id);
  }
  const chipCounts = {};
  for (const r of rankedCatText) for (const c of tools.find((t) => t.id === r.tool_id).tags) chipCounts[c] = (chipCounts[c] ?? 0) + 1;
  const browse = {
    featured: recommendations.slice(0, opts.featuredN).map((r) => r.tool_id),
    categories: taxonomy.categories
      .filter((c) => byCat.has(c.id))
      .sort((a, b) => a.sort - b.sort)
      .map((c) => ({ id: c.id, label: c.label, color: c.color, count: byCat.get(c.id).length, tool_ids: byCat.get(c.id) })),
    chips: Object.entries(chipCounts).map(([id, count]) => ({ id, label: taxonomy.chips[id], count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
  };

  return {
    recommendations,
    excluded,
    assessment_gaps: assessmentGaps(excluded),
    browse,
    meta: {
      engine_version: ENGINE_VERSION, taxonomy_version: taxonomy.version,
      options: opts, goals, evaluated: relevant.length, eligible: eligible.length, excluded: excluded.length,
      notice: 'Decision support only. Not a substitute for assessment by a qualified occupational therapist.',
    },
  };
}

// Which unanswered questions would unlock the most tools? Only counts tools with NO hard failure,
// so we never ask a question whose answer cannot change the outcome.
function assessmentGaps(excluded) {
  const gaps = new Map();
  for (const e of excluded) {
    for (const f of e.failures) {
      if (f.kind !== 'unconfirmed') continue;
      const key = `${f.code}:${f.target ?? ''}`;
      const g = gaps.get(key) ?? { code: f.code, target: f.target ?? null, blocks: 0, could_unlock: 0 };
      g.blocks += 1;
      if (e.could_unlock) g.could_unlock += 1;
      gaps.set(key, g);
    }
  }
  return [...gaps.values()].sort((a, b) => b.could_unlock - a.could_unlock || b.blocks - a.blocks || (a.code + a.target).localeCompare(b.code + b.target));
}
