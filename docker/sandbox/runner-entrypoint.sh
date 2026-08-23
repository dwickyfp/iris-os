#!/bin/sh
set -eu

socket=/var/run/docker.sock

if [ ! -S "$socket" ]; then
  echo "sandbox runner requires the Linux gVisor Compose overlay" >&2
  exit 1
fi

socket_gid="$(stat -c '%g' "$socket")"
exec gosu "10001:$socket_gid" "$@"
