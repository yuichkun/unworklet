#!/usr/bin/env bash
# Vercel build: build the workspace packages in dependency order (core and
# vite-plugin form a cycle, so the order is explicit, not `vp run -r`), then the
# demo app. Output: examples/demo/dist. Run from the repo root.
set -euo pipefail

vp run --filter @unworklet/lang build
vp run --filter @unworklet/vite-plugin build
vp run --filter @unworklet/core build
vp run --filter @unworklet/offline build
vp run --filter @unworklet/test build
vp run --filter @unworklet-examples/demo build
