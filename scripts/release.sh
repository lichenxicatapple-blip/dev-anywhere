#!/usr/bin/env bash
# 一键发布: 验证发布源分支 → 验证 CHANGELOG → release:check → release:smoke → bump 4 个 package.json
# → commit "release: vX.Y.Z" → tag vX.Y.Z → 确认后 push commit + tag。
# CI (.github/workflows/release.yml) 监听 tag push 后自动 build/publish docker + npm。
#
# 发布必须基于 main，并且本地 main 必须与 origin/main 完全一致。
#
# CHANGELOG.md 必须在跑脚本前写好 ## [X.Y.Z] - YYYY-MM-DD entry。脚本只校验存在,
# 不替你写——发布说明是创意工作, 自动生成不靠谱。
#
# 用法:
#   bash scripts/release.sh 0.2.2
#   bash scripts/release.sh --emergency 0.2.2
#
# 紧急发布模式只跳过 release:smoke, 仍保留 release:check 的构建与打包完整性门禁。
# 也可以用 RELEASE_EMERGENCY=1 bash scripts/release.sh 0.2.2。
# 幂等: 失败重跑会检测 commit / tag 是否已存在并跳过, 不会创建重复 commit。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EMERGENCY="${RELEASE_EMERGENCY:-0}"
TARGET_VERSION=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --emergency)
      EMERGENCY=1
      shift
      ;;
    --no-emergency)
      EMERGENCY=0
      shift
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [[ -n "$TARGET_VERSION" ]]; then
        echo "ERROR: unexpected extra argument: $1" >&2
        exit 2
      fi
      TARGET_VERSION="$1"
      shift
      ;;
  esac
done

if [[ -z "$TARGET_VERSION" ]]; then
  echo "usage: bash scripts/release.sh <version>" >&2
  echo "       bash scripts/release.sh --emergency <version>" >&2
  echo "  example: bash scripts/release.sh 0.2.2" >&2
  echo "  emergency: skips release:smoke only; release:check still runs" >&2
  exit 2
fi

TAG="v${TARGET_VERSION}"

if ! [[ "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: version must be X.Y.Z (got: $TARGET_VERSION)" >&2
  exit 2
fi

echo "=== Verify release source branch ==="
CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "ERROR: releases must be cut from main (current branch: ${CURRENT_BRANCH:-detached})" >&2
  echo "Switch to main, merge the intended changes, then rerun this release." >&2
  exit 1
fi
git fetch origin main --quiet
LOCAL_MAIN="$(git rev-parse main)"
REMOTE_MAIN="$(git rev-parse origin/main)"
if [[ "$LOCAL_MAIN" != "$REMOTE_MAIN" ]]; then
  echo "ERROR: local main does not match origin/main" >&2
  echo "Run: git pull --ff-only origin main" >&2
  exit 1
fi
echo "OK: release source is main and matches origin/main"

PKG_FILES=(
  "apps/proxy/package.json"
  "apps/relay/package.json"
  "apps/web/package.json"
  "packages/shared/package.json"
)

CURRENT_VERSION="$(node -p "require('./apps/proxy/package.json').version")"
echo "Current version: $CURRENT_VERSION"
echo "Target version:  $TARGET_VERSION"
if [[ "$EMERGENCY" == "1" ]]; then
  echo "Mode:            emergency (release:smoke skipped)"
fi

if [[ "$CURRENT_VERSION" == "$TARGET_VERSION" ]]; then
  # 幂等支路: bump 已经做过, 但 commit/tag/push 还没做完。允许继续。
  echo "INFO: package.json already at $TARGET_VERSION; assuming resume after partial run"
fi

# 版本必须严格大于当前 (按 X.Y.Z 字典序在限定到数字位时与版本序一致)
HIGHER="$(printf '%s\n%s\n' "$CURRENT_VERSION" "$TARGET_VERSION" | sort -V | tail -1)"
if [[ "$HIGHER" != "$TARGET_VERSION" ]]; then
  echo "ERROR: target version $TARGET_VERSION is not greater than current $CURRENT_VERSION" >&2
  exit 2
fi

echo "=== Verify CHANGELOG entry exists ==="
if ! grep -qE "^## \\[${TARGET_VERSION}\\]" CHANGELOG.md; then
  echo "ERROR: CHANGELOG.md missing entry '## [${TARGET_VERSION}]' — write release notes first" >&2
  exit 1
fi
echo "OK: CHANGELOG.md has [${TARGET_VERSION}] entry"

echo "=== Verify git working tree state ==="
# 允许的 dirty 文件: CHANGELOG.md (release notes) + 4 个 package.json (如果脚本之前部分跑过)。
# 任何其它文件 dirty 都拒绝, 避免发布混入未审查改动。
DIRTY="$(git status --porcelain)"
ALLOWED_RE='^.. (CHANGELOG\.md|apps/proxy/package\.json|apps/relay/package\.json|apps/web/package\.json|packages/shared/package\.json)$'
UNEXPECTED="$(printf '%s\n' "$DIRTY" | grep -vE "$ALLOWED_RE" | grep -v '^$' || true)"
if [[ -n "$UNEXPECTED" ]]; then
  echo "ERROR: unexpected uncommitted changes:" >&2
  echo "$UNEXPECTED" >&2
  echo "Commit or stash these before releasing." >&2
  exit 1
fi
echo "OK: working tree clean except CHANGELOG / package.json"

echo "=== Verify tag does not yet exist locally or remotely ==="
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "INFO: local tag ${TAG} already exists; will reuse if it points at the upcoming commit"
  TAG_EXISTS_LOCAL=1
else
  TAG_EXISTS_LOCAL=0
fi
# 远端 tag 检查: 已发布的 tag 绝不允许覆盖
if git ls-remote --tags origin "${TAG}" 2>/dev/null | grep -q "refs/tags/${TAG}\$"; then
  echo "ERROR: remote tag ${TAG} already exists — cannot republish" >&2
  exit 1
fi

echo "=== Run release:check ==="
pnpm release:check

if [[ "$EMERGENCY" == "1" ]]; then
  echo "=== EMERGENCY RELEASE: skipping release:smoke ==="
else
  echo "=== Run release:smoke ==="
  pnpm release:smoke
fi

echo "=== Bump 4 package.json to ${TARGET_VERSION} ==="
for f in "${PKG_FILES[@]}"; do
  # macOS sed 需要 -i ''; node 改写更可移植
  node -e "
    const fs = require('fs');
    const path = '$f';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf-8'));
    if (pkg.version === '$TARGET_VERSION') { console.log(path + ' already at $TARGET_VERSION'); process.exit(0); }
    pkg.version = '$TARGET_VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    console.log(path + ' bumped to $TARGET_VERSION');
  "
done

echo "=== Commit release ==="
git add CHANGELOG.md "${PKG_FILES[@]}"

# 幂等支路: 如果 HEAD 已经是这次的 release commit (pkg + CHANGELOG 都和工作区一致, 没有
# 待 staged 的内容了), 跳过创建新 commit, 进入 tag 阶段。
if git diff --cached --quiet; then
  HEAD_MSG="$(git log -1 --pretty=%s)"
  if [[ "$HEAD_MSG" == "release: ${TAG}" ]]; then
    echo "INFO: HEAD already at 'release: ${TAG}', skipping commit"
  else
    echo "ERROR: nothing staged but HEAD is '${HEAD_MSG}', not 'release: ${TAG}'" >&2
    exit 1
  fi
else
  git commit -m "release: ${TAG}"
fi

RELEASE_SHA="$(git rev-parse HEAD)"

echo "=== Tag ${TAG} ==="
if [[ "$TAG_EXISTS_LOCAL" == "1" ]]; then
  EXISTING_TAG_SHA="$(git rev-parse "refs/tags/${TAG}")"
  if [[ "$EXISTING_TAG_SHA" != "$RELEASE_SHA" ]]; then
    echo "ERROR: existing local tag ${TAG} points at ${EXISTING_TAG_SHA}, not the release commit ${RELEASE_SHA}" >&2
    echo "Delete or fix the stale tag and retry." >&2
    exit 1
  fi
  echo "INFO: tag ${TAG} already at ${RELEASE_SHA}"
else
  git tag -a "${TAG}" -m "release: ${TAG}"
fi

echo ""
echo "=== Ready to push ==="
echo "  Branch: $(git rev-parse --abbrev-ref HEAD)"
echo "  Commit: ${RELEASE_SHA} ($(git log -1 --pretty=%s))"
echo "  Tag:    ${TAG} -> ${RELEASE_SHA}"
echo ""
echo "Pushing the tag triggers .github/workflows/release.yml to publish docker + npm."

if [[ "${RELEASE_SKIP_PUSH:-}" == "1" ]]; then
  echo ""
  echo "RELEASE_SKIP_PUSH=1 set; stopping before push. To push later:"
  echo "  git push origin $(git rev-parse --abbrev-ref HEAD)"
  echo "  git push origin ${TAG}"
  exit 0
fi

# 所有门禁过了 (release:check / release:smoke / tag不存在 / dirty 限定),
# 直接推; 想跳过推的话用 RELEASE_SKIP_PUSH=1。
echo ""
echo "=== Pushing commit and tag ==="
git push origin "$(git rev-parse --abbrev-ref HEAD)"
git push origin "${TAG}"

REMOTE_PATH="$(git remote get-url origin | sed -E 's|.*github.com[:/]||; s|\.git$||')"
echo ""
echo "Pushed. CI: https://github.com/${REMOTE_PATH}/actions"
