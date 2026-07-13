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

# Smoke test: build the amd64 image alone, run it, and require the proxy to
# serve the Portainer UI with our injected CSS before pushing anything. The
# layers built here are reused by the multi-arch build below.
echo "Smoke test (amd64) of $TAG from $BASE_REF..."
docker buildx build \
  --platform=linux/amd64 \
  --load \
  -t "smoke-test:$TAG" \
  --build-arg PORTAINER_REF="$BASE_REF" \
  --cache-from=type=gha \
  .

SMOKE_ID=$(docker run --rm -d -p 127.0.0.1:9000:9000 "smoke-test:$TAG")
trap 'docker stop "$SMOKE_ID" >/dev/null 2>&1 || true' EXIT

BODY=""
for _ in $(seq 1 30); do
  if BODY=$(curl -fsS http://127.0.0.1:9000/ 2>/dev/null) \
    && echo "$BODY" | grep -q 'be-indicator-container'; then
    break
  fi
  BODY=""
  sleep 2
done

if [ -z "$BODY" ]; then
  echo "Smoke test FAILED: proxy did not serve the injected Portainer UI within 60s"
  docker logs "$SMOKE_ID" 2>&1 | tail -50 || true
  exit 1
fi
echo "Smoke test passed."
docker stop "$SMOKE_ID" >/dev/null 2>&1 || true
trap - EXIT

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
