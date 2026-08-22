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

The sandbox is an optional platform service used by `python_compute` and
workflow compute. `SandboxManager` coordinates policy, durable session and
execution state, provider calls, artifacts, cancellation, and cleanup. It is not
an `ExecutionDriver` and does not own an agent/model loop.

## Security Boundary

- `sandbox-runner` is the only service with the Docker socket. The socket is
  added only by `compose.linux-gvisor.yml`.
- `iris-os`, `iris-worker`, `memory-worker`, `sandbox-package-broker`, and child
  containers never receive the socket.
- Runner code creates one child per session dynamically. Compose does not run a
  persistent execution child.
- Every child must use Docker runtime `runsc`, no network by default, a
  read-only root filesystem, non-root UID 10001, dropped capabilities,
  `no-new-privileges`, finite CPU/memory/PID/time limits, and ephemeral `tmpfs`
  storage.
- Networked workload profiles remain denied by application policy. The runner
  supports a future networked profile only by attaching its child to the
  internal `sandbox-child-broker` network, never to the runner/app/data control
  plane or directly to an external-egress network.
- Only `sandbox-package-broker` joins both `sandbox-child-broker` and
  `sandbox-broker-egress`. It is the sole possible bridge from an untrusted child
  toward external registries; the runner does not join either network.
- The package broker only validates authorization policy for exact registry
  specs. npm requests use
  `name@exact-semver`; PyPI requests use `name==exact-version`. Ranges, tags,
  URLs, VCS references, local paths, options, and extras are denied.
- The current broker is authorization-only and explicitly reports delivery as
  `disabled` and claims as `unsupported`. It does not install, execute, fetch,
  stage, cache, or claim package delivery. Package egress and runtime package
  requests are disabled. An approved authorization response is not package
  support. Add authenticated fetching, digest verification, staging, caching,
  and offline installation before changing this contract, and keep package
  lifecycle scripts disabled.

## Rich Data Runtime

The Python 3.12 runtime includes pinned NumPy, pandas, SciPy, PyArrow, DuckDB,
Matplotlib, scikit-learn, OpenPyXL, XlsxWriter, python-docx, python-pptx,
ReportLab, pypdf, and Pillow distributions. All transitive dependencies are
pinned and hash-locked in `requirements-runtime-amd64.txt` and
`requirements-runtime-arm64.txt`. Docker selects the matching lock through
BuildKit `TARGETARCH`, installs wheels only with `--require-hashes --no-deps`,
and runs `runtime-smoke.py` as UID 10001 during the image build. The smoke script
imports every requested module and verifies its exact distribution version.

Change direct pins only in `requirements-runtime.in`, install `uv`, and run
`pnpm sandbox:lock`. Lock generation resolves Python 3.12 against glibc 2.28
wheel targets for amd64 and arm64 and rejects dependencies without wheels.
Review both generated locks before committing them.

The base Python image is pinned to a multi-platform OCI digest. The runner still
requires `SANDBOX_RUNNER_IMAGE` to be an immutable image ID or registry digest;
the base digest does not replace that runtime image pin.

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

`SANDBOX_CHILD_BROKER_NETWORK` names the internal child-facing network and
`SANDBOX_BROKER_EGRESS_NETWORK` names the broker-only external network. Do not
reuse either for the app, runner, workers, PostgreSQL, Redis, or other trusted
services, and never assign the same Docker network name to separate topology
roles. These topology settings do not enable networked workloads: the
application policy continues to accept only the default `network: "none"`
profile, and the package broker remains non-fetching.

Sandbox compute limits are enforced in PostgreSQL per agent run. Each execution
atomically reserves its timeout against committed plus reserved compute before
runner execution starts. Pre-execution reservations expire after one minute and
are released; started executions retain their reservation until settlement and
are conservatively charged their full timeout if settlement is still missing
one minute after that timeout. Cancellation may win terminal status, but cannot
erase a later fenced, idempotent compute settlement.

## Startup Reconciliation

The authenticated runner inventory contains only operational identity and
resource metadata: runner instance ID, control-plane session ID, root run ID,
runner boot ID, state, profile ID/network mode, effective limits, and lifecycle
timestamps. It contains no user, workspace, task, code, file, output, or other
PII. The control plane, not the privileged runner, reconciles this inventory
against PostgreSQL.

For an active session, the control-plane session, root run, provider, provider
instance, and profile identity must match and the authoritative run tree must
still be live without a cancellation request. Effective runner limits and expiry
are then refreshed in PostgreSQL. A mismatch, terminal/cancelled run,
quarantined container, terminal DB session, or orphan container is destroyed.
An active DB session whose exact container is absent is marked lost.

A `creating` row's expiry is also its creator lease. If a matching container is
on the runner's current boot and that lease is unexpired, the creator remains
the deterministic owner and reconciliation retains without activating it. If
the lease expired, or the container survived a runner restart, reconciliation
may take over. Takeover locks the session row and authoritative run records,
rechecks cancellation and all identities, then atomically records the provider
instance and effective profile/limits while clearing the creator token. Creator
activation uses the same row/run fence and is idempotent only for that exact
adopted provider instance; a competing instance loses and is destroyed.

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
pnpm sandbox:security
```

`sandbox:security` fails unless it is running on Linux against a Linux Docker
Engine with a registered `runsc` runtime. It statically checks the CI/runtime
contract, creates a real `runsc` container, inspects its runtime, network,
read-only filesystem, capabilities, privilege, and PID settings, and verifies
the effective UID, capability set, `no-new-privileges`, and root filesystem at
runtime. It never installs gVisor and has no fallback runtime.

Start the application plus sandbox control plane after the Linux/runsc checks and
operator configuration pass:

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
into `sandbox-runner`, the smoke service uses `runsc` with no network, both
control and child-facing networks are internal, and exact service membership
keeps the runner/app/workers/data services off child-facing and broker-egress
networks.

The `Sandbox gVisor Security` GitHub Actions workflow runs only on a self-hosted
runner carrying the `Linux` and `gvisor` labels. It is manually triggerable and
also triggered by a published release. The workflow runs `sandbox:build`,
`sandbox:smoke`, and `sandbox:security`; it remains queued or fails when the
dedicated runner or required runtime is unavailable. This is a real Linux/gVisor
workflow definition, but the repository contains no retained successful run
evidence. Its checked-in existence, static checks, and local non-Linux checks do
not establish that it has run or externally validate a deployment. After build
and runtime checks, the workflow generates a CycloneDX JSON SBOM and uploads it
as the `iris-sandbox-runtime-sbom` artifact.

Sandbox completion can be subject to durable compute settlement and canonical
artifact verification. Those checks establish the configured accounting,
ownership, storage, metadata, and byte-integrity properties only. They do not
prove that executed code is benign, output is semantically correct, or an
operator's host has the required isolation until that host passes and retains
the Linux/gVisor evidence above.

Inspect the effective deployment when changing Compose assets:

```sh
docker compose \
  -f docker/compose.yml \
  -f docker/sandbox/compose.yml \
  -f docker/sandbox/compose.linux-gvisor.yml \
  --profile smoke config
```
