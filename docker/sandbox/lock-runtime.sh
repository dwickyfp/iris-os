#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
input="$root/docker/sandbox/requirements-runtime.in"

for target in amd64:x86_64-manylinux_2_28 arm64:aarch64-manylinux_2_28; do
  arch=${target%%:*}
  platform=${target#*:}
  uv pip compile "$input" \
    --python-version 3.12 \
    --python-platform "$platform" \
    --only-binary :all: \
    --generate-hashes \
    --no-annotate \
    --custom-compile-command "pnpm sandbox:lock" \
    --output-file "$root/docker/sandbox/requirements-runtime-$arch.txt"
done
