#!/bin/bash
set -euo pipefail

# Builds one tag, with the portainer base image pinned to BASE_REF
# (e.g. portainer/portainer-ce@sha256:...) so the result is unambiguous
# even if upstream re-points a tag mid-run. Invoked by ci_cd.js.

IMAGE="ghcr.io/notjosh/portainer-ce-without-annoying"
ARCHS="linux/amd64,linux/arm64,linux/arm/v7"
SOURCE_URL="https://github.com/notjosh/portainer-ce-without-annoying"

: "${TAG:?Please set TAG environment variable (output tag, e.g. 2.43.0)}"
: "${BASE_REF:?Please set BASE_REF environment variable (e.g. portainer/portainer-ce@sha256:...)}"

CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

EXTRA_ARGS=()
if [[ "$BASE_REF" == *@sha256:* ]]; then
  EXTRA_ARGS+=(--label "org.opencontainers.image.base.digest=${BASE_REF#*@}")
fi
if [[ -n "${METADATA_FILE:-}" ]]; then
  EXTRA_ARGS+=(--metadata-file "$METADATA_FILE")
fi

echo "Multi-arch build of $IMAGE:$TAG from $BASE_REF..."
docker buildx build \
  --platform="$ARCHS" \
  --push \
  -t "$IMAGE:$TAG" \
  --build-arg PORTAINER_REF="$BASE_REF" \
  --label "org.opencontainers.image.source=$SOURCE_URL" \
  --label "org.opencontainers.image.description=Drop-in replacement for portainer/portainer-ce without annoying UI elements" \
  --label "org.opencontainers.image.licenses=MIT" \
  --label "org.opencontainers.image.version=$TAG" \
  --label "org.opencontainers.image.base.name=docker.io/$BASE_REF" \
  --label "org.opencontainers.image.created=$CREATED" \
  "${EXTRA_ARGS[@]}" \
  --cache-from=type=gha \
  --cache-to=type=gha,mode=max \
  .
