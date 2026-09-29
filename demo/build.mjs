// Assembles demo/peo-matcher.html: inlines the real engine, validator, taxonomy, catalogue and example profiles.
import { readFileSync, writeFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^import .*$/gm, '').replace(/^export /gm, '');
const data = { taxonomy: JSON.parse(r('../data/taxonomy.json')), tools: JSON.parse(r('../data/tools.seed.json')).tools, profiles: JSON.parse(r('../examples/profiles.json')) };
const json = JSON.stringify(data).replace(/<\//g, '<\\/');
writeFileSync(new URL('peo-matcher.html', import.meta.url), r('template.html').replace('__ENGINE__', () => strip(r('../src/validate.mjs')) + '\n' + strip(r('../src/engine.mjs'))).replace('__DATA__', () => json));
