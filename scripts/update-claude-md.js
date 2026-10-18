#!/usr/bin/env node
/**
 * Regenerates the code-derived block of CLAUDE.md from the source tree, so a new
 * agent session starts from the app as it is, not as it was last described.
 *
 *   node scripts/update-claude-md.js          rewrite the block in place
 *   node scripts/update-claude-md.js --check  exit 1 if the block is stale
 *
 * Only the text between the markers is touched; everything else in CLAUDE.md is
 * hand-written and must be kept current by whoever changes the behaviour.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** @import { WidgetDef } from '../src/widgets/registry.js' */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = join(ROOT, 'CLAUDE.md');
const BEGIN = '<!-- BEGIN GENERATED: scripts/update-claude-md.js — do not edit by hand -->';
const END = '<!-- END GENERATED -->';

/** @param {string} dir @param {string} ext @returns {string[]} */
function listFiles(dir, ext) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(path, ext);
      return entry.name.endsWith(ext) ? [path] : [];
    })
    .sort();
}

/**
 * First sentence of the module's leading doc comment: the first block comment
 * reached before any statement other than an import.
 * @param {string} source
 * @returns {string | null}
 */
function moduleSummary(source) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#!') || line.startsWith('import ')) continue;
    if (!line.startsWith('/**')) return null;
    const end = lines.findIndex((l, j) => j >= i && l.includes('*/'));
    const text = lines
      .slice(i, end + 1)
      .map((l) => l.replace(/^\s*\/\*\*\s?|\s*\*\/\s*$|^\s*\*\s?/g, '').trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.match(/^.*?\.(?=\s|$)/)?.[0] ?? text;
  }
  return null;
}

async function generate() {
  const modules = listFiles(join(ROOT, 'src'), '.js').map((path) => {
    const summary = moduleSummary(readFileSync(path, 'utf8'));
    return `- \`${relative(ROOT, path)}\` — ${summary ?? '**no module doc comment; add one**'}`;
  });

  const { WIDGETS } = await import(pathToFileURL(join(ROOT, 'src/widgets/registry.js')).href);
  /** @type {Readonly<Record<string, WidgetDef>>} */
  const registry = WIDGETS;
  const widgets = Object.values(registry).map((w) => `- \`${w.type}\` — ${w.title}: ${w.description}`);

  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const commands = Object.entries(scripts).map(([name, cmd]) => `- \`npm run ${name}\` — \`${cmd}\``);

  const tests = [...listFiles(join(ROOT, 'tests'), '.test.js'), ...listFiles(join(ROOT, 'e2e'), '.spec.js')].map(
    (path) => `\`${relative(ROOT, path)}\``,
  );

  return [
    BEGIN,
    '',
    '### Modules (`src/`)',
    '',
    ...modules,
    '',
    '### Registered widgets',
    '',
    ...widgets,
    '',
    '### npm scripts',
    '',
    ...commands,
    '',
    '### Test suites',
    '',
    tests.join(', '),
    '',
    END,
  ].join('\n');
}

const doc = readFileSync(DOC, 'utf8');
const start = doc.indexOf(BEGIN);
const stop = doc.indexOf(END);
if (start === -1 || stop === -1 || stop < start) {
  console.error(`[update-claude-md] CLAUDE.md is missing its generated-block markers:\n  ${BEGIN}\n  ${END}`);
  process.exit(2);
}

const next = doc.slice(0, start) + (await generate()) + doc.slice(stop + END.length);
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('[update-claude-md] CLAUDE.md is stale; run: node scripts/update-claude-md.js');
    process.exit(1);
  }
} else if (next !== doc) {
  writeFileSync(DOC, next);
}
