#!/usr/bin/env bash
# Vercel build: build the workspace packages in dependency order, then the demo
# app. Output: examples/demo/dist. Run from the repo root. The order is explicit
# (not `vp run -r`) because core and unplugin form a cycle. core comes first:
# @unworklet/lang's browser build inlines core's worklet runtime by bundling
# @unworklet/core/worklet (resolved from its dist), so core must be built before
# lang.
set -euo pipefail

vp run --filter @unworklet/core build
vp run --filter @unworklet/unplugin build
vp run --filter @unworklet/offline build
vp run --filter @unworklet/test build
vp run --filter @unworklet/lang build
vp run --filter @unworklet-examples/demo build
