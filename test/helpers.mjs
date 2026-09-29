import { readFileSync } from 'node:fs';
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
export const taxonomy = read('../data/taxonomy.json');
export const tools = read('../data/tools.seed.json').tools;
export const profiles = read('../examples/profiles.json');
export const ALLOW_DRAFT = { requireClinicalReview: false };
export const clone = (x) => structuredClone(x);
export const toolById = (id) => tools.find((t) => t.id === id);
// A profile that passes everything except what a test deliberately withholds.
export function fullProfile(goals = []) {
  return {
    person: { capacities: Object.fromEntries(Object.keys(taxonomy.dimensions).map((d) => [d, 4])), risk_flags: [], risk_screening_complete: true, tech_literacy: Object.keys(taxonomy.tech_tags) },
    environment: { confirmed_tags: [] },
    occupation: { goals },
  };
}
