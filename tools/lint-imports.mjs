/**
 * Development helper for the UI: reports imported bindings that are never
 * referenced, and imported names the target module does not actually export.
 *
 * Not part of the shipped app. Run with `node tools/lint-imports.mjs`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'ui', 'js');

const files = readdirSync(dir).filter((name) => name.endsWith('.js'));

/** Matches every top-level import statement in a module. */
const IMPORT_HEAD = /^import\s[\s\S]*?from\s*['"][^'"]+['"];?/gm;

/** Names a module exports. */
function exportsOf(source) {
  const names = new Set();

  const declaration = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(declaration)) names.add(match[1]);

  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const aliased = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(aliased ? aliased[1] : trimmed.split(/\s+/)[0]);
    }
  }

  return names;
}

/** Names brought into scope by a module's import statements. */
function importsOf(source) {
  const found = [];

  for (const statement of source.match(IMPORT_HEAD) ?? []) {
    const from = statement.match(/from\s*['"]([^'"]+)['"]/)?.[1];

    const named = statement.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        found.push({ local: trimmed.split(/\s+as\s+/).pop().trim(), from });
      }
    }

    const defaultImport = statement.match(/^import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/);
    if (defaultImport) found.push({ local: defaultImport[1], from });
  }

  return found;
}

const sources = new Map(files.map((name) => [name, readFileSync(join(dir, name), 'utf8')]));

let problems = 0;

for (const file of files) {
  const source = sources.get(file);
  // The import block is stripped before the usage test, so an import cannot
  // count as a use of itself.
  const body = source.replace(IMPORT_HEAD, '');

  for (const { local } of importsOf(source)) {
    if (!local) continue;
    // `\b` only works when the name starts and ends with a word character, so
    // short punctuation-named helpers like `$` are matched literally instead.
    const quoted = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /^\w/.test(local) && /\w$/.test(local)
      ? new RegExp(`\\b${quoted}\\b`)
      : new RegExp(quoted);
    if (pattern.test(body)) continue;
    console.log(`${file}: "${local}" is imported but never used`);
    problems += 1;
  }

  const localImports = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w.-]+)['"]/g;
  for (const match of source.matchAll(localImports)) {
    const target = match[2].endsWith('.js') ? match[2] : `${match[2]}.js`;
    const targetSource = sources.get(target);

    if (!targetSource) {
      console.log(`${file}: module "./${match[2]}" does not exist`);
      problems += 1;
      continue;
    }

    const available = exportsOf(targetSource);
    for (const part of match[1].split(',')) {
      const imported = part.trim().split(/\s+as\s+/)[0].trim();
      if (!imported) continue;
      if (!available.has(imported)) {
        console.log(`${file}: "./${match[2]}" does not export "${imported}"`);
        problems += 1;
      }
    }
  }
}

console.log(problems === 0 ? 'imports OK' : `${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
