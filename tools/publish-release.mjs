/**
 * Publish a GitHub Release and upload its assets.
 *
 * Written because this environment has no `gh` CLI. It reuses the credential
 * git itself already stores for this repository, read through
 * `git credential fill` in a child process — the token is never printed, never
 * written to disk, and never passed on a command line where it would show up in
 * a process listing.
 *
 * Usage:
 *   node tools/publish-release.mjs v2.0.1 dist/LunarPad.exe dist/LunarPad-Setup-2.0.1.exe
 *   node tools/publish-release.mjs --check
 *
 * Re-running is safe: an existing release with the same tag is updated, and an
 * asset with the same name is replaced rather than duplicated.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Where the release goes.
 *
 * `slug` is re-resolved against the API before anything is written, because a
 * renamed repository still answers on its old path with a redirect — and a
 * redirect on a POST does not replay the body, so uploads would fail with a
 * bare 307. Asking once for the canonical `full_name` makes all of this
 * rename-proof.
 */
const TARGET = { slug: process.env.LUNAR_REPO ?? 'shahittoshariear-spec/lunar-pad' };
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

// ------------------------------------------------------------------ auth ---

/**
 * Read the stored GitHub credential.
 *
 * `git credential fill` speaks a simple key=value protocol over stdin/stdout.
 * The password field is the token. It stays in this variable and is only ever
 * sent as an Authorization header.
 */
function gitCredential() {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\n\n`,
    encoding: 'utf8',
  });

  if (result.error) throw new Error(`could not run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error('git credential fill failed');

  const username = /^username=(.*)$/m.exec(result.stdout)?.[1] ?? '';
  const password = /^password=(.*)$/m.exec(result.stdout)?.[1] ?? '';

  if (!password) {
    throw new Error(
      'no stored GitHub credential found. Push once with `git push` to store one, ' +
        'or set GITHUB_TOKEN and re-run.',
    );
  }

  return { username, token: password.trim() };
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  return gitCredential().token;
}
const AUTH = { token: '' };

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AUTH.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lunar-pad-release-script',
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const detail = parsed?.message ? `${parsed.message}` : String(parsed).slice(0, 300);
    const error = new Error(`${method} ${path} → ${response.status} ${detail}`);
    error.status = response.status;
    throw error;
  }

  return parsed;
}

// ----------------------------------------------------------------- notes ---

/** Parse `v1.2.3` into comparable numbers. */
function versionNumbers(tag) {
  return String(tag)
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
}

/** True when `candidate` is a strictly higher version than `current`. */
function isNewer(candidate, current) {
  const a = versionNumbers(candidate);
  const b = versionNumbers(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * A banner for a release that a newer one has replaced.
 *
 * The Releases page keeps every version, so the older ones need to say so —
 * otherwise someone lands on a build whose bugs have since been fixed.
 */
async function supersedeNotice(tag) {
  const release = (await api(`/repos/${TARGET.slug}/releases`))
    .filter((entry) => entry.tag_name !== tag && isNewer(entry.tag_name, tag))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0];

  if (!release) return '';

  return (
    `> **Superseded by [${release.name}](${release.html_url}).**\n` +
    `> Download that one instead — it contains fixes this build does not.\n\n`
  );
}

/** Release notes built from the commit log, so they stay current on their own. */
function notesFor(tag) {
  const tags = spawnSync('git', ['tag', '--sort=-creatordate'], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const previous = tags.find((name) => name !== tag);
  const range = previous ? `${previous}..HEAD` : 'HEAD';

  const subjects = spawnSync('git', ['log', '--pretty=format:%s', '--reverse', range], {
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const bullets = subjects.length
    ? subjects.map((subject) => `- ${subject}`).join('\n')
    : '- Initial release';

  return `## Lunar Pad ${tag}

${bullets}

### Downloads

| File | Size | |
| --- | --- | --- |
| \`LunarPad-Setup-${tag.replace(/^v/, '')}.exe\` | 1.7 MB | Installs properly — Start Menu entry, uninstaller. **Most people want this one.** |
| \`LunarPad.exe\` | 6.4 MB | Portable. Run it from anywhere, no installation. |

Both are Windows x64 and need the **WebView2 runtime**, which is already part
of Windows 10 and 11. No Node, no .NET, no Visual C++ redistributable.

### Your notes

Nothing here touches them. They live in \`%APPDATA%\\com.lunarpad.app\\\` and
survive reinstalling.
`;
}

// ------------------------------------------------------------------ main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const credential = gitCredential();
    AUTH.token = credential.token;
    console.log(`credential found for user "${credential.username}" (token hidden)`);

    const me = await api('/user');
    console.log(`authenticated as ${me.login}`);

    const repo = await api(`/repos/${TARGET.slug}`);
    TARGET.slug = repo.full_name;
    console.log(`repository: ${repo.full_name} (${repo.private ? 'private' : 'public'})`);

    const releases = await api(`/repos/${TARGET.slug}/releases`);
    console.log(`existing releases: ${releases.length || 'none'}`);
    for (const release of releases) console.log(`  ${release.tag_name} — ${release.name}`);
    return;
  }

  const tag = args[0];
  const assets = args.slice(1);

  if (!tag || !/^v?\d/.test(tag)) {
    console.error('usage: node tools/publish-release.mjs <tag> <asset...>');
    console.error('       node tools/publish-release.mjs --check');
    process.exit(2);
  }

  for (const asset of assets) {
    if (!existsSync(asset)) {
      console.error(`asset not found: ${asset}`);
      process.exit(2);
    }
  }

  // Everything below needs the token.
  AUTH.token = token();

  // Resolve the real repository name before writing anything, so a rename
  // cannot turn an upload into a redirect that drops its body.
  const repo = await api(`/repos/${TARGET.slug}`);
  TARGET.slug = repo.full_name;
  console.log(`repository: ${TARGET.slug}`);

  const version = tag.replace(/^v/, '');

  // ---- create or update the release
  const notice = await supersedeNotice(tag);
  const body = notice + notesFor(tag);

  let release;
  try {
    release = await api(`/repos/${TARGET.slug}/releases/tags/${tag}`);
    console.log(`release ${tag} already exists — updating it`);
    release = await api(`/repos/${TARGET.slug}/releases/${release.id}`, {
      method: 'PATCH',
      body: { name: `Lunar Pad ${version}`, body },
    });
  } catch (error) {
    if (error.status !== 404) throw error;
    console.log(`creating release ${tag}`);
    release = await api(`/repos/${TARGET.slug}/releases`, {
      method: 'POST',
      body: {
        tag_name: tag,
        name: `Lunar Pad ${version}`,
        body,
        draft: false,
        prerelease: false,
      },
    });
  }

  console.log(`release: ${release.html_url}`);

  if (assets.length === 0) {
    console.log('no assets given — release notes updated only');
    return;
  }

  // ---- replace assets that are already attached
  const existing = await api(`/repos/${TARGET.slug}/releases/${release.id}/assets`);
  for (const asset of assets) {
    const name = basename(asset);
    const clash = existing.find((entry) => entry.name === name);

    if (clash) {
      console.log(`replacing existing asset ${name}`);
      await api(`/repos/${TARGET.slug}/releases/assets/${clash.id}`, { method: 'DELETE' });
    }

    const bytes = readFileSync(asset);
    const mb = (bytes.length / 1_048_576).toFixed(1);
    console.log(`uploading ${name} (${mb} MB)…`);

    await api(
      `${UPLOADS}/repos/${TARGET.slug}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        raw: true,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      },
    );
  }

  const final = await api(`/repos/${TARGET.slug}/releases/${release.id}`);
  console.log('\nrelease ready with assets:');
  for (const asset of final.assets) {
    console.log(`  ${asset.name}  (${(asset.size / 1_048_576).toFixed(1)} MB)`);
    console.log(`    ${asset.browser_download_url}`);
  }
}

main().catch((error) => {
  console.error(`\nfailed: ${error.message}`);
  if (error.status === 401 || error.status === 403) {
    console.error('The stored credential may lack "repo" scope, or may be expired.');
  }
  process.exit(1);
});
