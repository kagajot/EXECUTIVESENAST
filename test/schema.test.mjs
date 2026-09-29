import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { tools, profiles, taxonomy } from './helpers.mjs';
import { validateCatalog } from '../src/validate.mjs';

const schema = (n) => JSON.parse(readFileSync(new URL(`../schema/${n}.schema.json`, import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = {};
const compiled = (n) => (validators[n] ??= ajv.compile(schema(n)));

test('every seed tool conforms to tool.schema.json', () => {
  const v = compiled('tool');
  for (const t of tools) assert.ok(v(t), `${t.id}: ${JSON.stringify(v.errors)}`);
});
test('every example profile conforms to profile.schema.json', () => {
  const v = compiled('profile');
  for (const [k, p] of Object.entries(profiles)) assert.ok(v(p), `${k}: ${JSON.stringify(v.errors)}`);
});
test('seed catalogue passes vocabulary validation', () => validateCatalog(tools, taxonomy));
test('clinician_reviewed status requires reviewer and date', () => {
  const v = compiled('tool');
  const t = structuredClone(tools[0]);
  t.safety_review = { status: 'clinician_reviewed', reviewed_by: null, reviewed_on: null };
  assert.equal(v(t), false);
});
