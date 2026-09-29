#!/usr/bin/env node
// Usage: node src/cli.mjs <profile_key> [--allow-draft] [--json] [--category=id] [--chip=id] [--q=text]
import { readFileSync } from 'node:fs';
import { recommend } from './engine.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const taxonomy = read('../data/taxonomy.json');
const { tools } = read('../data/tools.seed.json');
const profiles = read('../examples/profiles.json');

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('--'));
if (!key || !profiles[key]) {
  console.error(`Profiles: ${Object.keys(profiles).join(', ')}`);
  process.exit(1);
}
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const profile = structuredClone(profiles[key]);
profile.occupation.query = { category: flag('category'), chips: args.filter((a) => a.startsWith('--chip=')).map((a) => a.slice(7)), text: flag('q') };

const out = recommend({ profile, tools, taxonomy, options: { requireClinicalReview: !args.includes('--allow-draft') } });
if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const table = (rows, cols) => {
  if (!rows.length) return '  (none)\n';
  const w = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.f(r)).length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return [line(cols.map((c) => c.h)), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => c.f(r))))].join('\n') + '\n';
};

console.log(`\nPROFILE: ${profile.person.label}`);
console.log(`Goals: ${profile.occupation.goals.join(', ')}   |   evaluated ${out.meta.evaluated}, eligible ${out.meta.eligible}, excluded ${out.meta.excluded}`);
if (!args.includes('--allow-draft')) console.log('NOTE: requireClinicalReview=true and every seed entry is "draft" -> nothing can be recommended. Use --allow-draft for the demo.');

console.log('\nRECOMMENDED (passed every gate)');
console.log(table(out.recommendations, [
  { h: 'score', f: (r) => r.score.toFixed(3) }, { h: 'tool', f: (r) => r.tool_id }, { h: 'category', f: (r) => r.category },
  { h: 'hazard', f: (r) => r.hazard_severity }, { h: 'cautions', f: (r) => r.cautions.join(' ') },
]));
console.log('BROWSE (survivors only)');
console.log(table(out.browse.categories, [{ h: 'category', f: (c) => c.label }, { h: 'n', f: (c) => c.count }, { h: 'tools', f: (c) => c.tool_ids.join(', ') }]));
console.log(`  chips: ${out.browse.chips.map((c) => `${c.label} (${c.count})`).join(' | ') || '(none)'}\n`);

console.log('EXCLUDED (audit)');
console.log(table(out.excluded.flatMap((e) => e.failures.map((f, i) => ({ e, f, i }))), [
  { h: 'tool', f: ({ e, i }) => (i === 0 ? e.tool_id : '') }, { h: 'kind', f: ({ f }) => f.kind },
  { h: 'code', f: ({ f }) => f.code }, { h: 'detail', f: ({ f }) => f.detail },
]));
console.log('ASSESSMENT GAPS (questions that could unlock tools; unlocks = tools with no hard failure)');
console.log(table(out.assessment_gaps, [{ h: 'code', f: (g) => g.code }, { h: 'target', f: (g) => g.target ?? '-' }, { h: 'unlocks', f: (g) => g.could_unlock }, { h: 'blocks', f: (g) => g.blocks }]));
