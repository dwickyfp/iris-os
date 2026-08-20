# Trusted Sandbox Operations

After building the local runtime image, pin the runner to its immutable image ID:

```bash
export SANDBOX_RUNNER_IMAGE="$(docker image inspect iris-sandbox-runtime:local --format '{{.Id}}')"
```

Production should use a registry digest such as
`registry.example/iris-sandbox@sha256:<digest>` instead of a mutable tag.

The trusted sandbox executes code in short-lived Python 3.12 containers under
gVisor. It is an opt-in Linux deployment surface and is not part of the default
application Compose stack.

## Security Boundary

- `sandbox-runner` is the only service with the Docker socket. The socket is
  added only by `compose.linux-gvisor.yml`.
- `iris-os`, `iris-worker`, `memory-worker`, `sandbox-package-broker`, and child
  containers never receive the socket.
- Runner code creates one child per session dynamically. Compose does not run a
  persistent execution child.
- Every child must use Docker runtime `runsc`, the internal sandbox control
  network only when package authorization is needed, a read-only root
  filesystem, non-root UID 10001, dropped capabilities, `no-new-privileges`,
  finite CPU/memory/PID/time limits, and ephemeral `tmpfs` storage.
- The package broker only authorizes exact registry specs. npm requests use
  `name@exact-semver`; PyPI requests use `name==exact-version`. Ranges, tags,
  URLs, VCS references, local paths, options, and extras are denied.
- The current broker is an authorization skeleton. It does not install or
  execute packages. Add registry fetching only behind this policy and keep
  package lifecycle scripts disabled.

Docker socket access is equivalent to host-root authority. Treat the runner as
a privileged control-plane component even though its process drops to UID
10001. Do not expose runner or broker ports on the host.

## Linux Setup

Use a dedicated Linux host with Docker Engine. Install gVisor `runsc` from the
official gVisor packages for the host distribution, then register it with the
Docker daemon. A typical `/etc/docker/daemon.json` runtime entry is:

```json
{
  "runtimes": {
    "runsc": {
      "path": "/usr/local/bin/runsc"
    }
  }
}
```

The package installation may place `runsc` elsewhere; use `command -v runsc`
and set the actual absolute path. Restart Docker and verify the runtime before
starting IRIS-OS:

```sh
docker info --format '{{json .Runtimes}}'
docker run --rm --runtime=runsc hello-world
```

Follow the current installation instructions at
<https://gvisor.dev/docs/user_guide/install/>. gVisor requires a compatible
Linux kernel and is not enabled merely by installing the `runsc` binary.

## Configuration

Copy values from `docker/sandbox/.env.example` into an operator-managed env
file. Generate `SANDBOX_RUNNER_TOKEN` with `openssl rand -base64 48` before any
runtime command. Compose startup and smoke commands fail interpolation when it
is absent and have no fallback token. Runner limits are global maxima: callers
may request lower per-session CPU, memory, tmpfs, PID, execution timeout, idle
TTL, and absolute TTL values, but cannot raise any of them. Effective limits are
retained with the live runner session. The runner atomically caps live plus
creating sessions with `SANDBOX_RUNNER_MAX_CONCURRENT_SESSIONS`.

Sandbox compute limits are enforced in PostgreSQL per agent run. Each execution
atomically reserves its timeout against committed plus reserved compute before
runner execution starts. Pre-execution reservations expire after one minute and
are released; started executions retain their reservation until settlement and
are conservatively charged their full timeout if settlement is still missing
one minute after that timeout. Cancellation may win terminal status, but cannot
erase a later fenced, idempotent compute settlement.

Build the runtime and validate package and Compose policy:

```sh
pnpm sandbox:build
pnpm sandbox:check
```

`sandbox:build` uses a command-scoped, non-secret Compose interpolation value
and never starts a service or embeds that value in an image. It is not a runtime
credential. `sandbox:up`, `sandbox:smoke`, and deployment rendering still
require the operator-generated token.

Run the gVisor smoke profile. Success proves that the image runs as UID 10001
through the Docker `runsc` runtime:

```sh
pnpm sandbox:smoke
```

Start the application plus sandbox control plane only after runner TypeScript
is present:

```sh
pnpm sandbox:up
```

Stop it with:

```sh
pnpm sandbox:down
```

## Unsupported Hosts

The trusted sandbox is unavailable on macOS, Docker Desktop for Mac, and
OrbStack because this deployment cannot establish and verify the required
native Linux gVisor boundary. A Linux VM hidden behind either product is not an
accepted production configuration.

There is no `runc`, Docker Desktop, OrbStack, process-only, or unsandboxed
fallback. If `runsc` is unavailable or the smoke test fails, keep sandbox
execution disabled and move the workload to a supported dedicated Linux host.

## Verification

`pnpm sandbox:check:compose` renders both the base extension and Linux overlay.
It fails unless the base has no socket mount, the overlay mounts the socket only
into `sandbox-runner`, and the smoke service uses `runsc` with no network.

Inspect the effective deployment when changing Compose assets:

```sh
docker compose \
  -f docker/compose.yml \
  -f docker/sandbox/compose.yml \
  -f docker/sandbox/compose.linux-gvisor.yml \
  --profile smoke config
```
