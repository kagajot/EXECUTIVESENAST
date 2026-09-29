// Vocabulary validation.
//
// Why this exists: a misspelled tag in `forbids_any` or `contraindicated_if_any`
// would never match anything, silently disabling a safety filter. Likewise a
// misspelled risk flag on a person profile would silently skip a contraindication.
// So every tag / dimension / task id is checked against the taxonomy and any
// unknown value is a hard error, not a warning.

export class ValidationError extends Error {
  constructor(errors) {
    super(`Validation failed:\n - ${errors.join('\n - ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const SEVERITIES = ['none', 'low', 'moderate', 'high'];
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function normalizeDemand(d) {
  return typeof d === 'number' ? { min: d, critical: false } : { min: d.min, critical: !!d.critical };
}

export function validateCatalog(tools, tax) {
  const errs = [];
  const seen = new Set();
  const dims = tax.dimensions, cats = tax.categories.map((c) => c.id);
  const check = (tool, label, values, vocab) => {
    for (const v of values ?? []) if (!(v in vocab)) errs.push(`${tool.id}: unknown ${label} "${v}"`);
  };
  for (const t of tools) {
    if (seen.has(t.id)) errs.push(`duplicate tool id "${t.id}"`);
    seen.add(t.id);
    if (!cats.includes(t.category)) errs.push(`${t.id}: unknown category "${t.category}"`);
    if (!t.addresses?.length) errs.push(`${t.id}: must address at least one task`);
    check(t, 'task', t.addresses, tax.tasks);
    check(t, 'chip tag', t.tags, tax.chips);
    check(t, 'risk flag (contraindicated_if_any)', t.contraindicated_if_any, tax.risk_flags);
    check(t, 'environment tag (requires_all)', t.environment?.requires_all, tax.environment_tags);
    check(t, 'environment tag (forbids_any)', t.environment?.forbids_any, tax.environment_tags);
    check(t, 'tech tag (daily_use)', t.tech?.daily_use, tax.tech_tags);
    check(t, 'tech tag (setup)', t.tech?.setup, tax.tech_tags);
    for (const [dim, raw] of Object.entries(t.demands ?? {})) {
      if (!(dim in dims)) { errs.push(`${t.id}: unknown demand dimension "${dim}"`); continue; }
      const d = normalizeDemand(raw);
      if (!isInt(d.min, 1, 4)) errs.push(`${t.id}: demand ${dim}.min must be an integer 1-4`);
    }
    for (const s of t.supervised_if_below ?? []) {
      if (!(s.dimension in dims)) errs.push(`${t.id}: unknown supervised_if_below dimension "${s.dimension}"`);
      if (!isInt(s.level, 1, 4)) errs.push(`${t.id}: supervised_if_below level must be 1-4`);
    }
    if (!SEVERITIES.includes(t.hazards?.severity)) errs.push(`${t.id}: hazards.severity must be one of ${SEVERITIES}`);
    if (!isInt(t.cost_band, 0, 3)) errs.push(`${t.id}: cost_band must be 0-3`);
    if (!isInt(t.complexity, 0, 3)) errs.push(`${t.id}: complexity must be 0-3`);
    if (!isInt(t.learning_burden, 0, 3)) errs.push(`${t.id}: learning_burden must be 0-3`);
    // A tool that shares tags across both lists would be unsatisfiable - almost certainly a data error.
    const both = (t.environment?.requires_all ?? []).filter((x) => (t.environment?.forbids_any ?? []).includes(x));
    if (both.length) errs.push(`${t.id}: environment tag(s) both required and forbidden: ${both}`);
  }
  if (errs.length) throw new ValidationError(errs);
}

export function validateProfile(profile, tax) {
  const errs = [];
  const { person, environment, occupation } = profile ?? {};
  if (!person || !environment || !occupation) {
    throw new ValidationError(['profile must contain person, environment and occupation (PEO)']);
  }
  for (const [dim, v] of Object.entries(person.capacities ?? {})) {
    if (!(dim in tax.dimensions)) errs.push(`person.capacities: unknown dimension "${dim}"`);
    else if (v !== null && v !== undefined && !isInt(v, 0, 4)) errs.push(`person.capacities.${dim} must be integer 0-4 or null`);
  }
  for (const f of person.risk_flags ?? []) if (!(f in tax.risk_flags)) errs.push(`person.risk_flags: unknown flag "${f}"`);
  for (const t of person.tech_literacy ?? []) if (!(t in tax.tech_tags)) errs.push(`person.tech_literacy: unknown tag "${t}"`);
  for (const t of environment.confirmed_tags ?? []) if (!(t in tax.environment_tags)) errs.push(`environment.confirmed_tags: unknown tag "${t}"`);
  for (const g of occupation.goals ?? []) if (!(g in tax.tasks)) errs.push(`occupation.goals: unknown task "${g}"`);
  const q = occupation.query ?? {};
  if (q.category && !tax.categories.some((c) => c.id === q.category)) errs.push(`occupation.query.category: unknown "${q.category}"`);
  for (const c of q.chips ?? []) if (!(c in tax.chips)) errs.push(`occupation.query.chips: unknown chip "${c}"`);
  if (person.budget_band !== undefined && !isInt(person.budget_band, 0, 3)) errs.push('person.budget_band must be 0-3');
  if (typeof person.risk_screening_complete !== 'boolean') errs.push('person.risk_screening_complete must be an explicit boolean');
  if (errs.length) throw new ValidationError(errs);
}
