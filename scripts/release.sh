#!/usr/bin/env bash
# 一键发布: 验证 CHANGELOG → release:check → release:smoke → bump 4 个 package.json
# → commit "release: vX.Y.Z" → tag vX.Y.Z → 确认后 push commit + tag。
# CI (.github/workflows/release.yml) 监听 tag push 后自动 build/publish docker + npm。
#
# CHANGELOG.md 必须在跑脚本前写好 ## [X.Y.Z] - YYYY-MM-DD entry。脚本只校验存在,
# 不替你写——发布说明是创意工作, 自动生成不靠谱。
#
# 用法: bash scripts/release.sh 0.2.2
# 幂等: 失败重跑会检测 commit / tag 是否已存在并跳过, 不会创建重复 commit。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$#" -ne 1 ]]; then
  echo "usage: bash scripts/release.sh <version>" >&2
  echo "  example: bash scripts/release.sh 0.2.2" >&2
  exit 2
fi

TARGET_VERSION="$1"
TAG="v${TARGET_VERSION}"

if ! [[ "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: version must be X.Y.Z (got: $TARGET_VERSION)" >&2
  exit 2
fi

PKG_FILES=(
  "apps/proxy/package.json"
  "apps/relay/package.json"
  "apps/web/package.json"
  "packages/shared/package.json"
)

CURRENT_VERSION="$(node -p "require('./apps/proxy/package.json').version")"
echo "Current version: $CURRENT_VERSION"
echo "Target version:  $TARGET_VERSION"

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

echo "=== Run release:smoke ==="
pnpm release:smoke

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
echo ""

if [[ "${RELEASE_SKIP_PUSH:-}" == "1" ]]; then
  echo "RELEASE_SKIP_PUSH=1 set; stopping before push. Run manually:"
  echo "  git push origin $(git rev-parse --abbrev-ref HEAD)"
  echo "  git push origin ${TAG}"
  exit 0
fi

read -r -p "Push commit + tag now? [y/N] " ANSWER
if [[ "${ANSWER}" != "y" && "${ANSWER}" != "Y" ]]; then
  echo "Aborted before push. To push later:"
  echo "  git push origin $(git rev-parse --abbrev-ref HEAD)"
  echo "  git push origin ${TAG}"
  exit 0
fi

git push origin "$(git rev-parse --abbrev-ref HEAD)"
git push origin "${TAG}"

echo ""
echo "Pushed. Watch CI: https://github.com/$(git remote get-url origin | sed -E 's|.*github.com[:/]||; s|\.git$||')/actions"
