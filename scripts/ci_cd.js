const path = require('path');
const { spawn } = require('child_process');

const ACCEPTED_TAGS_FROM = '2.17.0';
const UPSTREAM_REPO = 'portainer/portainer-ce';
const OUTPUT_OWNER = 'notjosh';
const OUTPUT_PACKAGE = 'portainer-ce-without-annoying';
const NUMBER_OF_TAGS_REBUILD = 5;

const shouldRebuild = !!process.argv.join(' ').match(/rebuild=true/);

function build_and_push(tag) {
  const cwd = path.join(__dirname, '..');
  const command = `TAG=${tag} ./scripts/build_and_push.sh`;

  return new Promise(resolve => {
    const subproc = spawn('/bin/sh', ['-c', command], { cwd });
    subproc.stdout.pipe(process.stdout);
    subproc.stderr.pipe(process.stderr);
    subproc.on('close', () => resolve());
  });
}


/////////////////////////////////////

/**
 * Prompt to ChatGPT: write js function that converts semver to int, for example 12.34.567 to 012034567. take into account case that input maybe 12.34 (output should be 012034000) or just 12 (output is 012000000)
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

// Fetch upstream (Docker Hub) tags for portainer/portainer-ce
async function fetchUpstreamTags(repoName) {
  const url = `https://hub.docker.com/v2/repositories/${repoName}/tags/?page_size=50&page=1`;
  const response = await fetch(url);
  return (await response.json())
    .results.map(result => result.name)
    .filter(t => t.match(/^(latest|[\d.]+)$/));
}

// Fetch already-published tags from GHCR via GitHub Packages REST API.
// Returns [] if the package doesn't exist yet (first run).
async function fetchGhcrTags(owner, packageName) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const tags = new Set();
  let page = 1;
  while (true) {
    const url = `https://api.github.com/users/${owner}/packages/container/${packageName}/versions?per_page=100&page=${page}`;
    const response = await fetch(url, { headers });
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(`GHCR API ${response.status}: ${await response.text()}`);
    }
    const versions = await response.json();
    if (!Array.isArray(versions) || versions.length === 0) break;
    for (const v of versions) {
      for (const t of (v.metadata?.container?.tags ?? [])) tags.add(t);
    }
    if (versions.length < 100) break;
    page++;
  }
  return [...tags].filter(t => t.match(/^(latest|[\d.]+)$/));
}

function findTagDifference(tagsA, tagsB) {
  return tagsA.filter(tag => !tagsB.includes(tag));
}

async function processRepos(upstreamRepo, outputOwner, outputPackage) {
  try {
    const tagsA = await fetchUpstreamTags(upstreamRepo);
    const tagsB = await fetchGhcrTags(outputOwner, outputPackage);
    console.log({ tagsA, tagsB });

    const tagDifference = shouldRebuild
      ? [...tagsB]
        .sort((a, b) => semverToInt(b) - semverToInt(a)) // sort desc
        .filter(t => t !== 'latest')
        .slice(0, NUMBER_OF_TAGS_REBUILD)
      : findTagDifference(tagsA, tagsB);

    // added by me
    const acceptTagsFrom = semverToInt(ACCEPTED_TAGS_FROM);
    const acceptedTags = tagDifference.filter(tag => semverToInt(tag) >= acceptTagsFrom);
    acceptedTags.sort((a, b) => semverToInt(a) - semverToInt(b));
    if (acceptedTags.length > 0) acceptedTags.push('latest');

    if (acceptedTags.length === 0) {
      console.log('No new tags to build, exit now');
      process.exit(0);
    }

    console.log('Tags to build:', acceptedTags);
    for (const tag of acceptedTags) {
      console.log(`============= Building ${tag} =============`);
      await build_and_push(tag);
      console.log(`=============   Done ${tag}   =============`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

processRepos(UPSTREAM_REPO, OUTPUT_OWNER, OUTPUT_PACKAGE);
