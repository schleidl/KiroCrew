# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# AgentCore worker image — a kiro-cli agent behind the Bedrock AgentCore Runtime
# container contract (GET /ping, POST /invocations -> text/event-stream).
#
# Platform requirements this file satisfies:
#   - linux/arm64 only (AgentCore Runtime accepts no other architecture).
#   - listens on :8080.
#   - <= 2 GB image (see the size guard at the end of the CLI install stage).
#
# Nothing here is account-specific: no account id, no ARN, no region, no
# credential. The image is built by infra/buildspec.yml in the target account and
# every runtime coordinate arrives as an environment variable from the runtime
# resource in infra/template.yaml.

# ── Base image ──────────────────────────────────────────────────────────────
# ECR Public (an AWS-owned registry), not Docker Hub: BuilderHub container
# guidelines require an AWS-owned source registry rather than an external
# third-party repository (Bosco/ACAT `non-ecr-docker-image`).
#
# Pinned by DIGEST, not tag: a tag is mutable, so a rebuild could otherwise ship
# a base image nobody reviewed or scanned. Refresh deliberately with
#   docker pull --platform linux/arm64 public.ecr.aws/docker/library/node:22-bookworm-slim \
#     && docker image inspect public.ecr.aws/docker/library/node:22-bookworm-slim \
#          --format '{{index .RepoDigests 0}}'
# and record the review in the commit that changes the digest.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# Refuse to build for anything but arm64. AgentCore rejects an amd64 image at
# runtime creation, which is a slow and confusing place to learn about it; a
# `docker build` without `--platform linux/arm64` fails here instead.
RUN test "$(dpkg --print-architecture)" = "arm64" \
    || { echo "FATAL: this image must be built for linux/arm64 (AgentCore requirement); got $(dpkg --print-architecture)" >&2; exit 1; }

# ── System dependencies ─────────────────────────────────────────────────────
# git + gh: clone and delivery. util-linux: `setpriv`, the privilege-drop
# mechanism used to run untrusted code as an unprivileged user (AgentCore
# forbids setuid escalation, so setpriv/runuser are the only options that work).
# unzip: the kiro-cli release archive. sudo: kept only as a fallback strategy for
# a platform that does permit setuid. `dist-upgrade` pulls the Debian security
# updates published after the base image was built, which is what keeps ECR
# scan-on-push quiet.
RUN apt-get update && apt-get -y --no-install-recommends dist-upgrade \
    && apt-get install -y --no-install-recommends \
       git curl unzip ca-certificates gnupg sudo util-linux \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ── Identities ──────────────────────────────────────────────────────────────
# Two OS identities share this container:
#   root    — the ORCHESTRATOR. Holds the forge installation token in memory and
#             resolves AWS credentials. Reads the model credential from Secrets
#             Manager and passes it only into the agent child's environment.
#   cmagent — UNTRUSTED. The kiro-cli agent child and every build/test script the
#             cloned repository supplies.
#
# The orchestrator runs as root ONLY because AgentCore forbids setuid escalation:
# a non-root process cannot switch to another user at all, while dropping
# privileges downward is always permitted. Root here lives in a disposable
# per-session microVM and holds no more AWS authority than the runtime role does;
# the code an attacker can actually influence runs unprivileged, with a scrubbed
# environment and no access to the orchestrator's process state.
# `cmwork` is the group both identities share so both can write the worktree.
#
# Created BEFORE the CLI install stage because that stage seeds the agent user's
# own home directory (see below).
RUN groupadd -r cmwork \
    && useradd -m -s /bin/bash -g cmwork cmagent \
    && printf 'root ALL=(cmagent) NOPASSWD: ALL\n' > /etc/sudoers.d/agentcore-worker \
    && chmod 0440 /etc/sudoers.d/agentcore-worker \
    && chmod 0700 /root \
    && chmod 0750 /home/cmagent \
    # An empty hooks directory to point core.hooksPath at, so a cloned
    # repository's own hooks never execute.
    && mkdir -p /opt/worker-nohooks && chmod 0755 /opt/worker-nohooks \
    # Shared, group-writable tool caches: either identity can populate them, so
    # the validation gate does not need a cold per-user cache.
    && mkdir -p /opt/worker-cache/corepack /opt/worker-cache/npm /opt/worker-cache/xdg \
    && chgrp -R cmwork /opt/worker-cache \
    && chmod -R 2777 /opt/worker-cache

# ── The agent binary ────────────────────────────────────────────────────────
# The aarch64 musl release archive, pinned by URL **and** SHA-256 rather than
# installed through `curl https://cli.kiro.dev/install | bash`: the install
# script resolves to whatever is current at build time, so a rebuild would ship
# a binary nobody reviewed. Both build args are REQUIRED — an empty SHA fails the
# build instead of silently skipping verification.
#
# Verified 2026-09-14 by HTTP HEAD: kirocli-aarch64-linux-musl.zip is
# 610,033,943 bytes (582 MiB), last modified 2026-09-11. AgentCore's image limit
# is 2 GB, hence the size guard at the end of this stage.
ARG KIRO_CLI_URL
ARG KIRO_CLI_SHA256
RUN set -eux; \
    test -n "${KIRO_CLI_URL:-}"  || { echo "FATAL: --build-arg KIRO_CLI_URL is required" >&2; exit 1; }; \
    test -n "${KIRO_CLI_SHA256:-}" || { echo "FATAL: --build-arg KIRO_CLI_SHA256 is required (pin the reviewed artifact)" >&2; exit 1; }; \
    curl -fsSL "$KIRO_CLI_URL" -o /tmp/kiro-cli.zip; \
    echo "${KIRO_CLI_SHA256}  /tmp/kiro-cli.zip" | sha256sum -c -; \
    unzip -q /tmp/kiro-cli.zip -d /opt/kiro-cli; \
    rm /tmp/kiro-cli.zip; \
    # The archive's internal layout is not contractual, so it is DISCOVERED and
    # asserted here rather than hardcoded: a layout change fails the build with a
    # clear message instead of producing an image that dies at first invocation.
    launcher="$(find /opt/kiro-cli -type f -name kiro-cli -print -quit)"; \
    chat="$(find /opt/kiro-cli -type f -name kiro-cli-chat -print -quit)"; \
    test -n "$launcher" || { echo "FATAL: kiro-cli not found in the archive" >&2; find /opt/kiro-cli -maxdepth 3 >&2; exit 1; }; \
    test -n "$chat"     || { echo "FATAL: kiro-cli-chat not found in the archive" >&2; find /opt/kiro-cli -maxdepth 3 >&2; exit 1; }; \
    chmod 0755 "$launcher" "$chat"; \
    # Terminal shell integration cannot be used headless, and the release ships
    # the `kiro-cli-term` binary plus one full-size copy per shell (bash, fish,
    # nu, zsh) — several hundred MB of payload this worker can never execute.
    # Dropped to stay clear of the 2 GB ceiling. Best-effort: absence is fine.
    find /opt/kiro-cli -type f \( -name 'kiro-cli-term' -o -name bash -o -name fish -o -name nu -o -name zsh \) -delete || true; \
    ln -sf "$launcher" /usr/local/bin/kiro-cli; \
    # CONFIRMED REQUIREMENT (WP1 probe, 2026-09-15, kiro-cli 2.21.4): the
    # launcher resolves its sibling at $HOME/.local/bin/kiro-cli-chat. Without
    # that exact path the child dies with
    #   error: failed to launch <HOME>/.local/bin/kiro-cli-chat
    # BEFORE authentication — this is the launcher, not a credential problem.
    # The agent child runs as cmagent with HOME=/home/cmagent, so that home is
    # the one that matters; /root is seeded too so an operator smoke test as the
    # orchestrator user behaves identically. Symlinks, not copies: the binaries
    # are ~86 MB each.
    # These directories stay root-owned and non-group-writable on purpose —
    # cmagent must not be able to swap the binary it is about to execute.
    for home in /home/cmagent /root; do \
      install -d -o root -g root -m 0755 "$home/.local" "$home/.local/bin"; \
      ln -sf "$launcher" "$home/.local/bin/kiro-cli"; \
      ln -sf "$chat"     "$home/.local/bin/kiro-cli-chat"; \
    done; \
    chmod -R go-w /opt/kiro-cli; \
    # A writable state directory for the agent user. Deliberately EMPTY: seeding
    # a credential store here would let the binary complete a device login and
    # persist a live token instead of failing fast. The probe confirmed ACP mode
    # exits immediately with "You are not logged in" when KIRO_API_KEY is absent,
    # so no login-suppression flag or guard is needed.
    install -d -o cmagent -g cmwork -m 0700 /home/cmagent/.kiro; \
    # Diagnostics, not gates. The artifact is a *musl* build running on a glibc
    # base: that works when it is statically linked, and needs a musl loader when
    # it is not. `ldd` says which, in the build log, on the first in-account
    # build — the container smoke test is the real assertion, so a non-zero exit
    # from either line must not fail the build.
    echo "--- kiro-cli linkage ---"; (ldd "$launcher" || true); (ldd "$chat" || true); \
    echo "--- kiro-cli --version ---"; (kiro-cli --version || echo "WARNING: kiro-cli --version failed at build time; the smoke test must confirm the binary runs"); \
    echo "--- kiro-cli payload size (2 GB image ceiling) ---"; du -sh /opt/kiro-cli

# ── Project toolchains (deployment choice, not a default) ───────────────────
# The agent clones and BUILDS the target repository inside this container, so the
# validation gate can only run what is installed here. Add arm64 builds of every
# compiler, runtime and package manager that repository needs, or the gate
# silently skips. Left commented because the right set depends on the repo this
# worker is pointed at — and every addition eats headroom under the 2 GB limit.
#
#   RUN apt-get update && apt-get install -y --no-install-recommends \
#         python3 python3-venv build-essential pkg-config \
#       && rm -rf /var/lib/apt/lists/*

# Enable corepack as root so the pnpm/yarn shims land on a PATH both identities
# can see; the validation gate then resolves each repo's pinned package manager.
RUN corepack enable

WORKDIR /app

# ── Worker sources ──────────────────────────────────────────────────────────
# Listed explicitly — never `COPY . .` — so nothing unexpected from the build
# context lands in the image. Every new module must be added here; a missing one
# only fails at container start, which is what the container smoke test catches.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.mjs hub.mjs session-guard.mjs secrets.mjs sandbox.mjs aws-identity.mjs \
     git.mjs git-auth.mjs integrate.mjs validate.mjs transcript-archive.mjs ./

# ── Runtime environment ─────────────────────────────────────────────────────
# AgentCore requires the container to listen on :8080.
#
# The cache paths are also declared as the sandbox module's cache root so its
# default and this image agree; the untrusted-environment allow-list forwards
# COREPACK_HOME / npm_config_cache / XDG_CACHE_HOME to build scripts.
#
# $HOME/.local/bin is on PATH for the kiro-cli launcher. It is root-owned, so an
# early PATH entry is not a write-up for the unprivileged user.
ENV PORT=8080 \
    PATH="/home/cmagent/.local/bin:${PATH}" \
    CLOUD_MODE_CACHE_ROOT=/opt/worker-cache \
    COREPACK_HOME=/opt/worker-cache/corepack \
    npm_config_cache=/opt/worker-cache/npm \
    XDG_CACHE_HOME=/opt/worker-cache/xdg
# KIRO_API_KEY is deliberately NOT set here, and no ARG carries it. The
# orchestrator reads it from Secrets Manager at run time and passes it only into
# the agent child's environment: it must never appear in an image layer, a log
# line, or an emitted event. Same for the forge credentials.
EXPOSE 8080

RUN chmod -R go-w /app
# See the identity comment above: root is the orchestrator only so it can drop
# privileges for untrusted code. If a future platform permits setuid again, set
# `USER node` and the sudo strategy takes over automatically.
USER root
CMD ["node", "server.mjs"]
