#!/bin/bash

# Get newest tag from https://hub.docker.com/r/portainer/portainer-ce/tags
# Also build one for :latest

IMAGE="ghcr.io/notjosh/portainer-ce-without-annoying"
ARCHS="linux/amd64,linux/arm64,linux/arm/v7"
SOURCE_URL="https://github.com/notjosh/portainer-ce-without-annoying"

if [ -z "$TAG" ]; then
  echo "Please set TAG environment variable"
  exit 1
fi

cp Dockerfile Dockerfile.tmp
sed -i "s/portainer-ce:latest/portainer-ce:$TAG/g" Dockerfile.tmp

echo "Multi-arch build..."
docker buildx build \
  --platform="$ARCHS" \
  --push \
  -t "$IMAGE:$TAG" \
  -f Dockerfile.tmp \
  --label "org.opencontainers.image.source=$SOURCE_URL" \
  --label "org.opencontainers.image.description=Drop-in replacement for portainer/portainer-ce without annoying UI elements" \
  --label "org.opencontainers.image.licenses=MIT" \
  --cache-from=type=gha \
  --cache-to=type=gha,mode=max \
  .
