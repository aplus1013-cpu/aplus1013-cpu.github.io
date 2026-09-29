#!/usr/bin/env bash
# 전체 자동 테스트: DB 권한 테스트 + 앱 전체 흐름(E2E)
# 필요: node_modules(@electric-sql/pglite, xlsx, @ffmpeg/core), deno, playwright, chromium
set -u
cd "$(dirname "$0")"
: "${SCRATCH:=$PWD/.tmp}"
export SCRATCH
export FFMPEG_CORE_DIR="${FFMPEG_CORE_DIR:-$PWD/node_modules/@ffmpeg/core/dist/esm}"
echo "== DB 권한·RPC 테스트 =="; node db.test.mjs; db=$?
echo; echo "== 앱 전체 흐름 테스트 =="; node e2e.test.mjs; e2e=$?
exit $(( db || e2e ))
