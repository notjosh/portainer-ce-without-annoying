// @ts-check
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ACCEPTED_TAGS_FROM = '2.17.0';
const UPSTREAM_REPO = 'portainer/portainer-ce';
const OUTPUT_OWNER = 'notjosh';
const OUTPUT_PACKAGE = 'portainer-ce-without-annoying';
const OUTPUT_IMAGE = `ghcr.io/${OUTPUT_OWNER}/${OUTPUT_PACKAGE}`;
const NUMBER_OF_TAGS_REBUILD = 5;

// Upstream tags that are moving pointers, not releases. We never *build* these:
// we re-point them at our own numbered builds (see reconcileAliases).
const ALIASES = ['latest', 'lts', 'sts'];

// A plain release tag like "2.43.0" (also accepts "2.43" / "2"), i.e. not
// suffixed variants like "2.43.0-alpine" and not alias tags.
const NUMBERED_TAG_PATTERN = /^\d+(\.\d+){0,2}$/;

const MAX_HUB_PAGES = 5;

const argv = process.argv.join(' ');
const shouldRebuild = /rebuild=true/.test(argv);
const isDryRun = /dryrun=true/.test(argv);

/**
 * @typedef {Object} HubTag
 * @property {string} name
 * @property {string | null} digest manifest (index) digest; missing on some older tags
 * @property {string[]} imageDigests per-platform image digests, used as a fallback for matching
 */

/**
 * @typedef {Object} BuildResult
 * @property {string} tag
 * @property {string} baseRef upstream ref the image was built FROM
 * @property {string | null} digest digest of the pushed image, if buildx reported one
 */

/////////////////////////////////////

/**
 * Prompt to ChatGPT: write js function that converts semver to int, for example 12.34.567 to 012034567. take into account case that input maybe 12.34 (output should be 012034000) or just 12 (output is 012000000)
 *
 * @param {string} semver
 * @returns {number}
 */
function semverToInt(semver) {
  const versionParts = semver.split('.');
  const paddedVersionParts = versionParts.map((part, index) => {
    const paddedPart = part.padStart(3, '0');
    return index < 2 ? paddedPart : paddedPart + '0'.repeat(6 - (versionParts.length - 1) * 3);
  });
  return parseInt(paddedVersionParts.join(''));
}

/////////////////////////////////////

/**
 * Run a command, streaming its output. Rejects on spawn failure or non-zero exit.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {Promise<void>}
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const subproc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    subproc.stdout.pipe(process.stdout);
    subproc.stderr.pipe(process.stderr);
    subproc.on('error', reject);
    subproc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

/**
 * Build and push one numbered tag, FROM pinned to the given upstream ref.
 *
 * @param {string} tag
 * @param {string} baseRef e.g. "portainer/portainer-ce@sha256:..."
 * @returns {Promise<BuildResult>}
 */
async function build_and_push(tag, baseRef) {
  const cwd = path.join(__dirname, '..');
  const metadataFile = path.join(os.tmpdir(), `build-metadata-${tag}.json`);

  await run('./scripts/build_and_push.sh', [], {
    cwd,
    env: {
      ...process.env,
      TAG: tag,
      BASE_REF: baseRef,
      METADATA_FILE: metadataFile,
    },
  });

  /** @type {string | null} */
  let digest = null;
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    digest = metadata['containerimage.digest'] ?? null;
  } catch {
    // metadata is best-effort, only used for the run summary
  }
  return { tag, baseRef, digest };
}

/////////////////////////////////////

/**
 * Fetch upstream (Docker Hub) tags with their digests. Paginates until every
 * alias can be resolved to a numbered tag, capped at MAX_HUB_PAGES.
 *
 * @param {string} repoName
 * @returns {Promise<HubTag[]>}
 */
async function fetchHubTags(repoName) {
  /** @type {HubTag[]} */
  const tags = [];
  /** @type {string | null} */
  let url = `https://hub.docker.com/v2/repositories/${repoName}/tags/?page_size=100&page=1`;

  for (let page = 0; url !== null && page < MAX_HUB_PAGES; page++) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Docker Hub API ${response.status}: ${await response.text()}`);
    }
    /** @type {{next: string | null, results: Array<{name: string, digest?: string | null, images?: Array<{os?: string, digest?: string | null}>}>}} */
    const body = await response.json();
    for (const result of body.results) {
      tags.push({
        name: result.name,
        digest: result.digest ?? null,
        imageDigests: (result.images ?? [])
          // "unknown" entries are attestation manifests, not real platforms
          .filter((image) => image.os !== 'unknown')
          .flatMap((image) => (image.digest ? [image.digest] : [])),
      });
    }
    const resolved = resolveAliases(tags);
    if (ALIASES.every((alias) => resolved[alias] !== undefined)) break;
    url = body.next;
  }
  return tags;
}

/**
 * @param {HubTag} a
 * @param {HubTag} b
 * @returns {boolean}
 */
function sameManifest(a, b) {
  if (a.digest && b.digest) return a.digest === b.digest;
  // fallback for tags without a top-level digest: same set of platform images
  if (a.imageDigests.length > 0 && b.imageDigests.length > 0) {
    return (
      a.imageDigests.every((digest) => b.imageDigests.includes(digest)) &&
      b.imageDigests.every((digest) => a.imageDigests.includes(digest))
    );
  }
  return false;
}

/**
 * Map each alias tag to the numbered tag publishing the same manifest.
 *
 * Digest matching is load-bearing: upstream `latest` follows the LTS line
 * (e.g. 2.39.4) while `sts` (e.g. 2.43.0) is newer, so "highest semver"
 * would pick the wrong version. Do not "simplify" this.
 *
 * @param {HubTag[]} hubTags
 * @returns {Record<string, string | undefined>} alias -> numbered tag
 */
function resolveAliases(hubTags) {
  const numbered = hubTags.filter((tag) => NUMBERED_TAG_PATTERN.test(tag.name));
  /** @type {Record<string, string | undefined>} */
  const mapping = {};
  for (const alias of ALIASES) {
    const aliasTag = hubTags.find((tag) => tag.name === alias);
    if (aliasTag === undefined) continue;
    const matches = numbered.filter((tag) => sameManifest(aliasTag, tag));
    // prefer the most specific match if several share a digest (e.g. 2.39 and 2.39.4)
    matches.sort((a, b) => semverToInt(b.name) - semverToInt(a.name));
    mapping[alias] = matches[0]?.name;
  }
  return mapping;
}

/**
 * Fetch already-published tags from the GHCR registry API. Anonymous pull
 * tokens work for public packages, so this needs no credentials (locally or
 * in CI). Returns [] if the package doesn't exist yet (first run).
 *
 * @param {string} owner
 * @param {string} packageName
 * @returns {Promise<string[]>}
 */
async function fetchGhcrTags(owner, packageName) {
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${packageName}:pull`
  );
  if (!tokenResponse.ok) {
    throw new Error(`GHCR token exchange failed: ${tokenResponse.status}`);
  }
  /** @type {{token: string}} */
  const { token } = await tokenResponse.json();

  const response = await fetch(
    `https://ghcr.io/v2/${owner}/${packageName}/tags/list?n=1000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`GHCR API ${response.status}: ${await response.text()}`);
  }
  /** @type {{tags: string[] | null}} */
  const body = await response.json();
  return body.tags ?? [];
}

/////////////////////////////////////

/**
 * Point alias tags at our numbered builds via a manifest-only copy: no
 * rebuild, and idempotent (re-pushing an identical manifest is a no-op).
 *
 * @param {Record<string, string | undefined>} aliasMap alias -> numbered tag
 * @param {string[]} availableTags numbered tags known to exist in GHCR
 * @returns {Promise<Record<string, string>>} alias -> outcome, for the summary
 */
async function reconcileAliases(aliasMap, availableTags) {
  /** @type {Record<string, string>} */
  const outcomes = {};
  /** @type {string[]} */
  const failures = [];

  for (const alias of ALIASES) {
    const target = aliasMap[alias];
    if (target === undefined) {
      console.warn(`WARNING: could not resolve upstream "${alias}" to a numbered tag, skipping`);
      outcomes[alias] = 'unresolved upstream';
      continue;
    }
    if (!availableTags.includes(target)) {
      console.warn(`WARNING: "${alias}" maps to ${target}, but ${OUTPUT_IMAGE}:${target} does not exist, skipping`);
      outcomes[alias] = `-> ${target} (missing, skipped)`;
      continue;
    }
    console.log(`Pointing ${alias} -> ${target}`);
    try {
      await run('docker', ['buildx', 'imagetools', 'create', '-t', `${OUTPUT_IMAGE}:${alias}`, `${OUTPUT_IMAGE}:${target}`]);
      outcomes[alias] = `-> ${target}`;
    } catch (error) {
      failures.push(`${alias}: ${error instanceof Error ? error.message : error}`);
      outcomes[alias] = `-> ${target} (FAILED)`;
    }
  }

  if (failures.length > 0) {
    throw new Error(`alias reconciliation failed:\n${failures.join('\n')}`);
  }
  return outcomes;
}

/**
 * Append a markdown summary to the GitHub Actions run page (or stdout locally),
 * so "what does latest point to" is answerable per-run.
 *
 * @param {BuildResult[]} built
 * @param {Record<string, string | undefined>} aliasMap
 * @param {Record<string, string>} aliasOutcomes
 * @param {HubTag[]} hubTags
 */
function writeSummary(built, aliasMap, aliasOutcomes, hubTags) {
  const lines = ['## Build and push summary', '', '### Built tags', ''];
  if (built.length === 0) {
    lines.push('_No new tags to build._');
  } else {
    lines.push('| Tag | Built from | Pushed digest |', '|---|---|---|');
    for (const result of built) {
      lines.push(`| \`${result.tag}\` | \`${result.baseRef}\` | \`${result.digest ?? 'unknown'}\` |`);
    }
  }
  lines.push('', '### Alias tags', '', '| Alias | Upstream digest | Outcome |', '|---|---|---|');
  for (const alias of ALIASES) {
    const upstreamDigest = hubTags.find((tag) => tag.name === alias)?.digest ?? 'unknown';
    lines.push(`| \`${alias}\` | \`${upstreamDigest}\` | ${aliasOutcomes[alias] ?? aliasMap[alias] ?? 'unresolved'} |`);
  }
  lines.push('');

  const markdown = lines.join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
  }
  console.log(markdown);
}

/////////////////////////////////////

/**
 * @param {string} upstreamRepo
 * @param {string} outputOwner
 * @param {string} outputPackage
 */
async function processRepos(upstreamRepo, outputOwner, outputPackage) {
  const hubTags = await fetchHubTags(upstreamRepo);
  const aliasMap = resolveAliases(hubTags);
  const ghcrTags = await fetchGhcrTags(outputOwner, outputPackage);
  const ghcrNumbered = ghcrTags.filter((tag) => NUMBERED_TAG_PATTERN.test(tag));

  const acceptTagsFrom = semverToInt(ACCEPTED_TAGS_FROM);
  const hubNumbered = hubTags
    .map((tag) => tag.name)
    .filter((name) => NUMBERED_TAG_PATTERN.test(name) && semverToInt(name) >= acceptTagsFrom);

  console.log({ hubNumbered, ghcrNumbered, aliasMap });

  /** @type {string[]} */
  let tagsToBuild;
  if (shouldRebuild) {
    tagsToBuild = [...ghcrNumbered]
      .sort((a, b) => semverToInt(b) - semverToInt(a)) // sort desc
      .slice(0, NUMBER_OF_TAGS_REBUILD);
  } else {
    // new upstream releases, plus alias targets we somehow missed; the latter
    // closes the gap in a single run instead of waiting for the next release
    const wanted = new Set(hubNumbered.filter((name) => !ghcrNumbered.includes(name)));
    for (const target of Object.values(aliasMap)) {
      if (target !== undefined && !ghcrNumbered.includes(target) && semverToInt(target) >= acceptTagsFrom) {
        wanted.add(target);
      }
    }
    tagsToBuild = [...wanted];
  }
  tagsToBuild.sort((a, b) => semverToInt(a) - semverToInt(b));

  console.log('Tags to build:', tagsToBuild);
  console.log('Alias plan:', aliasMap);

  if (isDryRun) {
    console.log('Dry run, stopping here.');
    return;
  }

  /** @type {BuildResult[]} */
  const built = [];
  for (const tag of tagsToBuild) {
    // pin FROM by digest so the build is unambiguous even if upstream re-tags
    const hubTag = hubTags.find((candidate) => candidate.name === tag);
    const baseRef = hubTag?.digest
      ? `${upstreamRepo}@${hubTag.digest}`
      : `${upstreamRepo}:${tag}`;

    console.log(`============= Building ${tag} (from ${baseRef}) =============`);
    built.push(await build_and_push(tag, baseRef));
    console.log(`=============   Done ${tag}   =============`);
  }

  const availableTags = [...new Set([...ghcrNumbered, ...built.map((result) => result.tag)])];
  /** @type {Record<string, string>} */
  let aliasOutcomes = {};
  try {
    aliasOutcomes = await reconcileAliases(aliasMap, availableTags);
  } finally {
    writeSummary(built, aliasMap, aliasOutcomes, hubTags);
  }
}

processRepos(UPSTREAM_REPO, OUTPUT_OWNER, OUTPUT_PACKAGE).catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
