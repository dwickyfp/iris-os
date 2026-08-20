#!/bin/sh
set -eu

socket=/var/run/docker.sock

if [ ! -S "$socket" ]; then
  echo "sandbox runner requires the Linux gVisor Compose overlay" >&2
  exit 1
fi

socket_gid="$(stat -c '%g' "$socket")"
if ! getent group "$socket_gid" >/dev/null 2>&1; then
  groupadd --gid "$socket_gid" docker-host
fi
socket_group="$(getent group "$socket_gid" | cut -d: -f1)"
usermod --append --groups "$socket_group" sandbox

exec gosu sandbox "$@"
