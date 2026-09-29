// Property test: fuzz thousands of random profiles and check every recommendation against an
// INDEPENDENT oracle (written separately from the engine) for the hard safety constraints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from '../src/engine.mjs';
import { tools, taxonomy, toolById, ALLOW_DRAFT } from './helpers.mjs';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const pick = (r, arr, p) => arr.filter(() => r() < p);

function randomProfile(r) {
  const capacities = {};
  for (const d of Object.keys(taxonomy.dimensions)) { const x = r(); capacities[d] = x < 0.15 ? null : x < 0.2 ? undefined : Math.floor(r() * 5); }
  return {
    person: {
      capacities, risk_flags: pick(r, Object.keys(taxonomy.risk_flags), 0.15), risk_screening_complete: r() < 0.7,
      tech_literacy: pick(r, Object.keys(taxonomy.tech_tags), 0.5), budget_band: Math.floor(r() * 4),
    },
    environment: { confirmed_tags: pick(r, Object.keys(taxonomy.environment_tags), 0.5) },
    occupation: { goals: pick(r, Object.keys(taxonomy.tasks), 0.3) },
  };
}

function oracleViolations(tool, p) {
  const v = [];
  const env = new Set(p.environment.confirmed_tags), caps = p.person.capacities;
  for (const f of tool.contraindicated_if_any) if (p.person.risk_flags.includes(f)) v.push(`contraindicated:${f}`);
  if ((tool.contraindicated_if_any.length || ['moderate', 'high'].includes(tool.hazards.severity)) && p.person.risk_screening_complete !== true) v.push('unscreened');
  for (const [d, raw] of Object.entries(tool.demands)) {
    const min = typeof raw === 'number' ? raw : raw.min;
    const crit = typeof raw === 'object' && raw.critical && tool.hazards.severity === 'high' ? 1 : 0;
    if (!Number.isInteger(caps[d]) || caps[d] < Math.min(4, min + crit)) v.push(`capacity:${d}`);
  }
  for (const t of tool.environment.requires_all) if (!env.has(t)) v.push(`env-missing:${t}`);
  for (const t of tool.environment.forbids_any) if (env.has(t)) v.push(`env-forbidden:${t}`);
  for (const t of tool.tech.daily_use) if (!p.person.tech_literacy.includes(t)) v.push(`tech-daily:${t}`);
  if (tool.setup_requires_helper && !env.has('helper_available_for_setup')) v.push('no-helper');
  for (const t of tool.tech.setup) if (!p.person.tech_literacy.includes(t) && !env.has('helper_available_for_setup')) v.push(`tech-setup:${t}`);
  for (const s of tool.supervised_if_below) if (!(caps[s.dimension] >= s.level) && !env.has('caregiver_present_during_use')) v.push(`unsupervised:${s.dimension}`);
  return v;
}

test('fuzz: no recommendation ever violates a hard safety constraint (3000 random profiles)', () => {
  const r = rng(42); let recs = 0, empties = 0;
  for (let i = 0; i < 3000; i++) {
    const p = randomProfile(r);
    const out = recommend({ profile: p, tools, taxonomy, options: ALLOW_DRAFT });
    if (!out.recommendations.length) empties++;
    for (const rec of out.recommendations) {
      recs++;
      const viol = oracleViolations(toolById(rec.tool_id), p);
      assert.deepEqual(viol, [], `iteration ${i}: ${rec.tool_id} recommended despite ${viol}\n${JSON.stringify(p)}`);
    }
    // Every browse/featured id must be a recommendation (no side door around the gates).
    const rec = new Set(out.recommendations.map((x) => x.tool_id));
    for (const c of out.browse.categories) for (const id of c.tool_ids) assert.ok(rec.has(id));
    for (const id of out.browse.featured) assert.ok(rec.has(id));
  }
  assert.ok(recs > 100, `fuzz too sparse to be meaningful (${recs} recs)`);
  assert.ok(empties > 100, 'fuzz should also exercise the empty-result path');
});

test('fuzz: with NO information at all (everything unknown) nothing is recommended except zero-demand, zero-hazard tools', () => {
  const p = { person: { capacities: {}, risk_flags: [], risk_screening_complete: false, tech_literacy: [] }, environment: { confirmed_tags: [] }, occupation: { goals: [] } };
  const out = recommend({ profile: p, tools, taxonomy, options: ALLOW_DRAFT });
  for (const rec of out.recommendations) {
    const t = toolById(rec.tool_id);
    assert.equal(Object.keys(t.demands).length, 0);
    assert.equal(t.hazards.severity, 'none');
  }
});
