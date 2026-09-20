#!/usr/bin/env node
/**
 * Traceability check (T22).
 *
 * Reads the @RF-xx / @INV-xx / @E2E-xx tags in unit and e2e tests and lists the
 * requirements that currently have no tagged test (warning mode).
 *
 * The expected universe (RF-01..RF-31, INV-01..INV-10, E2E-01..E2E-16) is derived
 * from docs/spec.md, which is the single source of truth.
 *
 * docs/pending.txt is a shrink-only baseline:
 *   - if it does not exist, it is created with the current missing set (baseline);
 *   - if a new gap appears (missing not contained in pending.txt), the check FAILS;
 *   - if coverage improves, pending.txt shrinks automatically.
 *
 * Exit codes: 0 = pass, 1 = fail (used by CI).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_FILE = join(ROOT, 'docs', 'spec.md');
const PENDING_FILE = join(ROOT, 'docs', 'pending.txt');
const TEST_ROOTS = [
  { dir: join(ROOT, 'src'), suffix: '.spec.ts' },
  { dir: join(ROOT, 'test'), suffix: '.e2e-spec.ts' },
];
const REQUIREMENT_RE = /\b(RF|INV|E2E)-(\d{1,2})\b/g;
const TAG_RE = /@(RF|INV|E2E)-(\d{1,2})\b/g;

function normalize(prefix, number) {
  return `${prefix}-${number.padStart(2, '0')}`;
}

function collect(text, pattern) {
  const set = new Set();
  for (const match of text.matchAll(pattern)) {
    set.add(normalize(match[1], match[2]));
  }
  return set;
}

function walkFiles(dir, suffix, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkFiles(full, suffix, out);
    } else if (entry.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

function taggedInTests() {
  const set = new Set();
  for (const { dir, suffix } of TEST_ROOTS) {
    if (!existsSync(dir)) continue;
    for (const file of walkFiles(dir, suffix)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(TAG_RE)) {
        set.add(normalize(match[1], match[2]));
      }
    }
  }
  return set;
}

function readPending(file) {
  if (!existsSync(file)) return null;
  const set = new Set();
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^(RF|INV|E2E)-\d{2}$/.test(line)) set.add(line);
  }
  return set;
}

function writePending(file, list) {
  const header = [
    '# IdemEngine traceability baseline (T22).',
    '# Requirements without a tagged test. Shrink-only: remove lines as coverage is',
    '# added (or let the script shrink it). Never grow this file: the check fails if',
    '# the missing set is not contained in this baseline.',
    '',
  ].join('\n');
  const body = [...list].sort().join('\n');
  writeFileSync(file, `${header}${body}\n`, 'utf8');
}

function printMissing(list) {
  const byPrefix = (prefix) => list.filter((id) => id.startsWith(prefix));
  if (list.length === 0) {
    console.log('  none');
    return;
  }
  for (const [label, items] of [
    ['RF', byPrefix('RF')],
    ['INV', byPrefix('INV')],
    ['E2E', byPrefix('E2E')],
  ]) {
    if (items.length > 0) console.log(`  ${label}: ${items.join(', ')}`);
  }
}

const spec = readFileSync(SPEC_FILE, 'utf8');
const universe = [...collect(spec, REQUIREMENT_RE)].sort();
const tagged = taggedInTests();
const missing = [...universe].filter((id) => !tagged.has(id)).sort();

const count = (prefix) => universe.filter((id) => id.startsWith(prefix)).length;
console.log('Traceability check (T22) — docs/spec.md vs tagged tests');
console.log(
  `  Universe : ${universe.length} requirements (RF ${count('RF')}, INV ${count('INV')}, E2E ${count('E2E')})`,
);
console.log(`  Tagged   : ${tagged.size} requirement(s) found in tests`);
console.log(
  `  Missing  : ${missing.length} requirement(s) without a tagged test`,
);
console.log('');

if (missing.length > 0) {
  console.log('Missing (current list of RF/INV/E2E without a tagged test):');
  printMissing(missing);
  console.log('');
}

const pending = readPending(PENDING_FILE);

if (pending === null) {
  writePending(PENDING_FILE, missing);
  console.log(
    `docs/pending.txt created with ${missing.length} baseline item(s). ` +
      'Add tagged tests (@RF-xx/@INV-xx/@E2E-xx) to shrink it.',
  );
  process.exit(0);
}

const newGaps = missing.filter((id) => !pending.has(id));
if (newGaps.length > 0) {
  console.error(
    'FAIL: new requirements have no tagged test (docs/pending.txt would grow):',
  );
  for (const id of newGaps) console.error(`  - ${id}`);
  console.error(
    'Add a tagged test that covers each of them. Do NOT edit docs/pending.txt to widen the baseline.',
  );
  process.exit(1);
}

const covered = [...pending].filter((id) => !missing.includes(id)).sort();
if (covered.length > 0) {
  writePending(PENDING_FILE, missing);
  console.log(
    `docs/pending.txt shrunk to ${missing.length} item(s): ${covered.length} requirement(s) now covered`,
  );
}

console.log(
  covered.length > 0 ? 'PASS (coverage improved, baseline shrunk)' : 'PASS',
);
process.exit(0);
