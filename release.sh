#!/bin/bash
set -euo pipefail

# EMTAC one-command release script
# - bumps PATCH version
# - commits + pushes main
# - creates/pushes annotated tag vX.Y.Z (single v)
#
# NOTE: npm prints versions with a leading "v" (e.g. "v1.1.20").
# We strip that so we don't accidentally create "vv1.1.20".

echo "==> Switching to main and pulling latest..."
git checkout main
git pull origin main

# Refuse to run if there are local changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Working tree has changes. Commit/stash them before releasing."
  git status --porcelain
  exit 1
fi

echo "==> Bumping PATCH version..."
RAW_VERSION="$(npm version patch --no-git-tag-version)"   # e.g. v1.1.20
VERSION="${RAW_VERSION#v}"                                #      1.1.20
TAG="v${VERSION}"                                         #     v1.1.20

echo "==> Running install to update lockfile..."
npm install

echo "==> Committing version bump (${VERSION})..."
git add package.json package-lock.json
git commit -m "Release ${VERSION}"

echo "==> Pushing main..."
git push origin main

# Ensure we don't accidentally create a duplicate tag
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "ERROR: Tag ${TAG} already exists locally."
  echo "If this is a retry, delete the tag locally+remote first."
  exit 1
fi

echo "==> Creating annotated tag ${TAG}..."
git tag -a "${TAG}" -m "${TAG}"

echo "==> Pushing tag ${TAG}..."
git push origin "${TAG}"

echo ""
echo "✅ Release ${TAG} pushed. GitHub Actions should now build + upload Windows assets."
