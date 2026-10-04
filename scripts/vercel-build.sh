#!/usr/bin/env bash
# The demo config rebuilds and fingerprints its workspace dependencies.
set -euo pipefail

vp run --filter @unworklet-examples/demo build
