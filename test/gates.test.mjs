import test from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from '../src/engine.mjs';
import { validateProfile, ValidationError } from '../src/validate.mjs';
import { tools, taxonomy, profiles, fullProfile, clone, ALLOW_DRAFT } from './helpers.mjs';

const run = (profile, options = ALLOW_DRAFT, catalog = tools) => recommend({ profile, tools: catalog, taxonomy, options });
const ids = (r) => r.recommendations.map((x) => x.tool_id);
const failCodes = (r, id) => r.excluded.find((e) => e.tool_id === id)?.failures.map((f) => f.code) ?? [];

test('G0: with default options nothing draft is ever recommended', () => {
  const p = fullProfile(['cut_food']); p.environment.confirmed_tags = ['kitchen_counter_workspace'];
  assert.equal(run(p, {}).recommendations.length, 0);
  assert.ok(failCodes(run(p, {}), 'rocker_knife').includes('REVIEW_REQUIRED'));
});

test('G1: incomplete risk screening blocks tools with hazards/contraindications', () => {
  const p = fullProfile(['cut_food']); p.environment.confirmed_tags = ['kitchen_counter_workspace']; p.person.risk_screening_complete = false;
  assert.ok(failCodes(run(p), 'rocker_knife').includes('SCREENING_INCOMPLETE'));
  p.person.risk_screening_complete = true;
  assert.deepEqual(ids(run(p)), ['rocker_knife']);
});

test('G2: contraindicating risk flag is a hard block even when every capacity is 4', () => {
  const p = fullProfile(['pick_up_items_floor']); p.person.risk_flags = ['high_fall_risk'];
  const r = run(p);
  assert.equal(ids(r).length, 0);
  assert.ok(failCodes(r, 'reacher_grabber').includes('CONTRAINDICATED'));
  assert.equal(r.excluded[0].could_unlock, false);
});

test('G3: capacity below demand blocks; unknown/absent capacity blocks (fail-closed)', () => {
  const p = fullProfile(['cut_food']); p.environment.confirmed_tags = ['kitchen_counter_workspace'];
  p.person.capacities.grip_strength = 1;
  assert.ok(failCodes(run(p), 'rocker_knife').includes('CAPACITY_BELOW_DEMAND'));
  p.person.capacities.grip_strength = null;
  assert.ok(failCodes(run(p), 'rocker_knife').includes('CAPACITY_UNKNOWN'));
  delete p.person.capacities.grip_strength;
  assert.ok(failCodes(run(p), 'rocker_knife').includes('CAPACITY_UNKNOWN'));
});

test('G3: critical dimension gets +1 margin on high-severity tools; exact-minimum fails', () => {
  const p = fullProfile(['shower_transfer']); p.environment.confirmed_tags = ['structural_modification_permitted', 'wall_blocking_present', 'helper_available_for_setup'];
  p.person.capacities.grip_strength = 2; // grab bar: critical min 2, severity high -> needs 3
  assert.ok(failCodes(run(p), 'installed_grab_bar').includes('CAPACITY_BELOW_DEMAND'));
  p.person.capacities.grip_strength = 3;
  assert.ok(ids(run(p)).includes('installed_grab_bar'));
});

test('G4: graded supervision - low safety judgment needs a person present, else blocked', () => {
  const p = fullProfile(['walk_household_distance']);
  p.environment.confirmed_tags = ['step_free_entry', 'doorways_32in_min'];
  p.person.capacities.safety_judgment = 2;
  assert.ok(failCodes(run(p), 'rollator').includes('SUPERVISION_UNAVAILABLE'));
  p.environment.confirmed_tags.push('caregiver_present_during_use');
  const r = run(p);
  assert.deepEqual(ids(r), ['rollator']);
  assert.ok(r.recommendations[0].cautions.some((c) => /another person present/.test(c)));
});

test('G5: required environment tag must be EXPLICITLY confirmed; absence is a failure', () => {
  const p = fullProfile(['cut_food']);
  assert.ok(failCodes(run(p), 'rocker_knife').includes('ENV_REQUIREMENT_UNCONFIRMED'));
});

test('G5: forbidden environment condition blocks (gas hob vs auto shut-off; rugs vs rollator)', () => {
  const p = fullProfile(['cook_hot_meal']); p.environment.confirmed_tags = ['electric_hob', 'gas_hob', 'structural_modification_permitted', 'helper_available_for_setup'];
  assert.ok(failCodes(run(p), 'stove_auto_shutoff').includes('ENV_FORBIDDEN_PRESENT'));
  const q = fullProfile(['walk_household_distance']); q.environment.confirmed_tags = ['step_free_entry', 'doorways_32in_min', 'loose_rugs_present'];
  assert.ok(failCodes(run(q), 'rollator').includes('ENV_FORBIDDEN_PRESENT'));
});

test('G6: daily-use tech cannot be delegated; setup tech can be delegated to a helper', () => {
  const p = fullProfile(['remember_appointments']);
  p.environment.confirmed_tags = ['wifi_home', 'smart_speaker_present'];
  p.person.tech_literacy = [];
  assert.ok(failCodes(run(p), 'smart_speaker_reminders').includes('TECH_UNCONFIRMED'));
  p.environment.confirmed_tags.push('helper_available_for_setup');
  assert.ok(failCodes(run(p), 'smart_speaker_reminders').includes('TECH_UNCONFIRMED'), 'daily voice_commands still missing');
  p.person.tech_literacy = ['voice_commands'];
  assert.ok(ids(run(p)).includes('smart_speaker_reminders'));
});

test('G7: budget is a preference exclusion, and is not reported as unlockable by assessment', () => {
  const p = fullProfile(['take_medications']); p.environment.confirmed_tags = ['wifi_home', 'power_outlet_near_counter']; p.person.budget_band = 1;
  const r = run(p);
  assert.ok(failCodes(r, 'locked_pill_dispenser').includes('BUDGET_EXCEEDED'));
  assert.equal(r.excluded.find((e) => e.tool_id === 'locked_pill_dispenser').could_unlock, false);
});

test('Query (category/chips/text) only narrows; a disqualified tool never appears via any query', () => {
  const p = clone(profiles.post_stroke_left_hemiparesis);
  const base = ids(run(p));
  assert.ok(!base.includes('reacher_grabber'));
  for (const query of [{ category: 'self_care' }, { text: 'reacher' }, { text: 'grabber' }, { chips: ['low_tech'] }, { category: 'self_care', text: 'pick up' }]) {
    const q = clone(p); q.occupation.query = query;
    const r = run(q);
    assert.ok(!ids(r).includes('reacher_grabber'), JSON.stringify(query));
    for (const id of ids(r)) assert.ok(base.includes(id), `${id} appeared only because of query`);
  }
});

test('Browse view: only categories/chips with surviving tools; featured = top-ranked survivors', () => {
  const r = run(clone(profiles.post_stroke_left_hemiparesis));
  const inBrowse = new Set(r.browse.categories.flatMap((c) => c.tool_ids));
  assert.deepEqual([...inBrowse].sort(), ids(r).sort());
  assert.ok(r.browse.categories.every((c) => c.count > 0));
  assert.deepEqual(r.browse.featured, ids(r).slice(0, 3));
  assert.ok(!r.browse.categories.some((c) => c.id === 'mobility_transfers'));
});

test('Assessment gaps: ranks the questions that would unlock the most tools; ignores hard-blocked tools', () => {
  const r = run(clone(profiles.incomplete_intake));
  assert.ok(r.assessment_gaps.length > 0);
  assert.ok(r.assessment_gaps.some((g) => g.code === 'SCREENING_INCOMPLETE'));
  for (let i = 1; i < r.assessment_gaps.length; i++) assert.ok(r.assessment_gaps[i - 1].could_unlock >= r.assessment_gaps[i].could_unlock);
});

test('Cognitive-impairment example: locked dispenser and smart speaker are excluded, low-tech options survive', () => {
  const r = run(clone(profiles.early_cognitive_impairment_lives_alone));
  assert.ok(failCodes(r, 'locked_pill_dispenser').includes('CAPACITY_BELOW_DEMAND'));
  assert.ok(failCodes(r, 'smart_speaker_reminders').includes('TECH_UNCONFIRMED'));
  assert.ok(ids(r).includes('paper_wall_calendar'));
  assert.ok(ids(r).includes('stove_auto_shutoff'));
});

test('Typos in safety-relevant vocabulary are hard errors, never silent', () => {
  const bad = clone(fullProfile(['cut_food']));
  bad.person.risk_flags = ['high_fal_risk'];
  assert.throws(() => run(bad), ValidationError);
  const badTool = clone(tools); badTool[0].environment.forbids_any = ['gas_hobb'];
  assert.throws(() => run(fullProfile(['cut_food']), ALLOW_DRAFT, badTool), ValidationError);
  const missingScreen = fullProfile([]); delete missingScreen.person.risk_screening_complete;
  assert.throws(() => validateProfile(missingScreen, taxonomy), ValidationError);
  const outOfRange = fullProfile([]); outOfRange.person.capacities.vision = 5;
  assert.throws(() => validateProfile(outOfRange, taxonomy), ValidationError);
});

test('Deterministic: same input -> identical output', () => {
  const p = clone(profiles.post_stroke_left_hemiparesis);
  assert.deepEqual(run(p), run(clone(p)));
});

test('Capacity failures carry structured have/need/min so the UI never parses strings', () => {
  const p = fullProfile(['shower_transfer']); p.environment.confirmed_tags = ['structural_modification_permitted', 'wall_blocking_present', 'helper_available_for_setup'];
  p.person.capacities.grip_strength = 2;
  const f = run(p).excluded.find((e) => e.tool_id === 'installed_grab_bar').failures.find((x) => x.code === 'CAPACITY_BELOW_DEMAND');
  assert.deepEqual({ have: f.have, need: f.need, min: f.min, target: f.target }, { have: 2, need: 3, min: 2, target: 'grip_strength' });
});
