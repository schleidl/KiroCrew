# AgentCore Remote Agents Implementation Plan

> **Live plan.** WP0 is complete (three PASS verdicts) and WP1's code is complete
> and green; WP1's deploy, image build and container smoke test remain, all human-gated. Its spec is
> [`../rfc-agentcore-remote-agents.md`](../rfc-agentcore-remote-agents.md).

> **For agentic workers:** each work package below is one task-runner run in its
> own git worktree and its own branch, ending in one pull request. Steps use
> checkbox (`- [ ]`) syntax for tracking. Runnable per-package specs live outside
> this repository, under the operator's workspace, because they name an account,
> a region and a runtime ARN that must not be committed to a public tree.

**Goal:** Spawn a `kiro-cli` coding agent on Bedrock AgentCore Runtime in the
operator's own account, and render it in the dashboard as if it were a local
subagent, including steer, stop, live streaming and the completion event.

**Architecture:** A new `agent.acp_backend` id whose harness spawns a local stdio
shim. The shim forwards newline-framed ACP JSON-RPC over a per-session UNIX socket
to a bridge in the gateway process, which translates to `InvokeAgentRuntime` plus
a server-sent event stream. The remote session enters through
`SessionManager.get_or_create`, so the whole subagent pipeline is untouched.
`agent.provider` stays `enum=["acp"]` and `CONTRACT_VERSION` stays `1`.

**Tech stack:** Python 3.10+, the existing harness and provider seams, governance
`SCOPE_CATALOG`, pytest-asyncio, and a Node worker container. `boto3` only behind
the `kirocrew[agentcore]` extra — public core imports no AWS SDK.

## Global constraints

- Default-off. Without the extra and without `capabilities.remote_exec`, behaviour
  is byte-identical to today.
- No hardcoded model id anywhere; the default stays `"auto"`.
- Identity and capability by positive membership only. Never `not
  is_claude_backend` or any other absence test.
- The agent's model credential never touches the operator's disk and never enters
  any agent context. Not as a value, not as a pointer.
- Runtime coordinates are keystone data, not `config.json` data.
- Local-process assumptions degrade to their documented unknown paths; nothing
  invents a fake pid.
- Every package updates the specs it changes in the same commit, and passes the
  local gate sequence in `AGENTS.md` before the pull request opens.
- One logical change per commit, at most two commits per pull request.

## Dependency order

```
WP0 ─┬─► WP1 ──────────────┐
     └─► WP2 ──► WP3 ──► WP4 ──► WP5
                                 └──► WP6
```

WP1 and WP2 are independent. WP3 is developed against a fake worker, so it does
not wait for WP1's deployment. A remote agent is visible end to end once WP1 is
deployed and WP2 through WP4 are merged.

## Stack and file map

| Package | Primary paths |
|---|---|
| WP1 | `packaging/agentcore-worker/` (new), infrastructure template |
| WP2 | `src/kiro_crew/agent_sdk/backends.py`, `src/kiro_crew/acp/harness/`, `src/kiro_crew/acp/types.py`, `src/kiro_crew/agentcore/stdio_shim.py` (new), `src/kiro_crew/platform/governance.py`, `src/kiro_crew/security/paths.py`, `src/kiro_crew/sandbox.py` |
| WP3 | `src/kiro_crew/agentcore/bridge.py`, `liveness.py`, `sse.py` (new), `test/agentcore/fake_worker.py` (new) |
| WP4 | `src/kiro_crew/mcp_tools/spawn.py`, `src/kiro_crew/dashboard/handlers/messaging.py`, `src/kiro_crew/cli_commands.py` |
| WP5 | `src/kiro_crew/subagent_manager/run.py`, `dashboard/ws.py`, `dashboard/slot_projection.py`, `dashboard/ws_event_scope.py`, `website/src/hooks/useWebSocket.ts`, `website/src/pages/chat/SubagentRunCard.tsx`, `website/src/pages/chat/ActivityViewer.tsx` |
| WP6 | `packaging/agentcore-worker/`, `src/kiro_crew/subagent_persistence.py`, `src/kiro_crew/monitoring/` |

### Stable interfaces

- `HarnessAdapter.resolve_spawn` returns a `SpawnPlan` whose `argv` is the only
  thing WP2 changes. No transport code is touched.
- The bridge exposes `start`, `send`, `attach`, `stop` and a heartbeat read. The
  shim speaks only bytes.
- The worker's action and event vocabulary is fixed by the RFC and pinned by
  WP1's tests, so WP3 can be written against it before the container exists.

## WP0: spike branch — three verdicts, no merge

Throwaway branch `spike/agentcore-probe`. Output is three verdict files plus, for
(b), a passing test in the worktree.

- [ ] **Spike A — headless agent in the container.** Build the arm64 image with
  `kiro-cli` and an API key from Secrets Manager; run one turn that reads a file
  and calls a tool; capture the ACP JSON lines and the per-turn credit report.
  Verdict: does a headless agent complete a turn in a microVM.
- [ ] **Spike B — per-session executor override.** Establish whether an
  `executor` value can reach backend selection through the single existing gate
  without adding a second one, proven by a test, not by reading.
- [ ] **Spike C — bidirectional JSON-RPC and resumability.** Round-trip a
  permission request over invoke plus SSE, then kill the stream mid-turn and
  resume with `attach(sinceSeq)`; assert no lost and no duplicated message.
- [ ] **Record the verdicts** in the RFC's open questions section. A failed
  Spike B switches WP4 to the dedicated-agent-configuration fallback.

## WP1: worker container and account resources

Branch `feat/agentcore-worker`.

- [x] **Step 1: Vendor the agent-agnostic modules.** Port the reference
  implementation's bounded sequence hub, owner-token guard, credential purge and
  orchestrator-identity split, git authentication helper, worktree and delivery
  helpers, validation gate, and transcript archiver. Keep their tests.
- [x] **Step 2: Rewrite the entrypoint around the agent child.** Replace the
  reference agent-session glue with a `kiro-cli acp` child launched through the
  privilege-drop helper; forward each stdout line as one `acp` event; implement
  `rpc`, `attach` and a real `stop`.
- [x] **Step 3: Fix the four inherited defects.** A real stop action; a bounded
  session map with a time-to-live; subscribe to the hub before delivering input
  so an `rpc` turn streams live; one result shape.
- [x] **Step 4: Image.** Digest-pinned base, git and the privilege-drop tooling,
  the agent binary for the container's architecture, a non-root uid for untrusted
  code, listen on the platform's required port.
- [x] **Step 5: Secret.** Add the model-credential secret to the stack and grant
  the runtime role read on it only.
- [x] **Step 6: Tests and gates.** Unit tests green — 132 tests, 132 pass. The
  container smoke test and the in-account build remain, both blocked on a runtime.
  **Two gaps found while reviewing, still open inside WP1:** the reference stack's
  strongest guard was `cdk/test/isolation.test.mjs`, which asserts the agent role's
  permitted actions by **exact-set equality**; the role it pinned no longer exists
  here, but the technique does and there is no template-shape test yet. And the
  reference's opt-in Network Firewall egress allow-list is not translated — only the
  plain VPC hook is, so the domain allow-list is the operator's to build.
  green against the built image; template linted.
- [ ] **Step 7: Human gate.** The operator deploys and writes the secret. Neither
  is agent work.

## WP2: backend id, harness, shim, keystone, governance

Branch `feat/agentcore-backend`.

- [ ] **Step 1: Write the failing tests.** The new backend resolves through the
  single gate; the tool gate does not refuse it; the keystone disposition pin
  covers the new leaf; spawn admission refuses when the scope is off.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Register the backend.** Fourteen sites, each pinned by a loud test,
  as Spike B measured: constant and known set, policy id, routing member (use
  `AGENT_SPEC` — every stronger member obliges a credential mask, a sandbox-tier
  consult and its own spawn preflight arm), provider label, model namespace, install
  probe, host-auth declaration, harness adapter, provider predicate, a frame-replay
  corpus covering seven frame classes, a projections declaration, nine columns in the
  host-contract table, and an onboarding paragraph. An explicit decision for every
  capability set. Not selectable on a baseline build. Declare session sharing
  ineligible **and force the dedicated arm explicitly**, or an executor on a
  sharing-eligible spawn is silently ignored.
- [ ] **Step 4: Add the shim.** A minimal stdio-to-socket relay with no
  credential and no second connection.
- [ ] **Step 5: Keystone and governance.** The runtime-coordinates leaf with its
  disposition, and the `capabilities.remote_exec` catalog row enforced
  fail-closed and audited at admission.
- [ ] **Step 6: Answer every harness-parity invariant** in the parity spec, and
  run the parity gate locally against the base branch.
- [ ] **Step 7: Specs and gates.** Update the parity, governance, security and
  platform-context specs, then run the full local sequence.

## WP3: the gateway bridge

Branch `feat/agentcore-bridge`.

- [ ] **Step 1: Build the fake worker fixture.** A local HTTP server speaking the
  RFC's action and event vocabulary, able to inject a mid-turn stream drop and a
  fatal error on demand.
- [ ] **Step 2: Write the failing tests.** Full turn; drop and gap-free resume;
  permission round-trip; stop escalation; a heartbeat gone quiet.
- [ ] **Step 3: Implement the bridge.** Lazy AWS import behind the extra; per-session
  socket; invoke for `start` and `rpc`; a long-lived attach stream with a
  sequence guard and short-interval re-attach; stop escalation from cooperative
  cancel through the worker action to the platform's session stop.
- [ ] **Step 4: Implement liveness.** No pid, a remote identifier, heartbeat-based
  aliveness, and session sharing declared ineligible.
- [ ] **Step 5: Gates.** Tests, type check on the Linux platform, docs.

## WP4: spawn surface

Branch `feat/agentcore-spawn`.

- [ ] **Step 1: Failing test.** A remote subagent driven by the fake worker
  produces a completion event in the parent and a local transcript file.
- [ ] **Step 2: Add the executor argument** to the spawn tool, the spawn route,
  the slot-creation route and the command-line twin, with strict session-key
  resolution and audit rows.
- [ ] **Step 3: Specs.** Subagent, MCP, session and feature-map indexes.
- [ ] **Step 4: Gates.**

## WP5: dashboard extras

Branch `feat/agentcore-ui`.

- [ ] **Step 1: Backend fields.** Executor kind, region and credits on the spawn
  and snapshot frames and the slot projection; a usage frame added to the event
  scope allowlist.
- [ ] **Step 2: Frontend.** One reducer case; a badge and a credit read-out in the
  run card and the agents panel; a composer toggle gated on the scope; every
  string through the catalog.
- [ ] **Step 3: Evidence.** A browser test that renders the badge from a replayed
  snapshot, plus a screenshot in the pull request.
- [ ] **Step 4: Gates.** Frontend build, tests, catalog check, feature map.

## WP6: delivery and durability

Branch `feat/agentcore-delivery`.

- [ ] **Step 1: Repository delivery.** Wire the ported validation and integration
  helpers as post-run steps, with the forge credential supplied through the git
  authentication helper so no token touches disk.
- [ ] **Step 2: Re-attach after a restart.** Persist the remote session id and the
  last rendered sequence number with the subagent's state, and resume on boot.
- [ ] **Step 3: Watch kind.** Register the remote run as a monitor kind, adding
  nothing to the decision, persistence, driver or delivery layers.
- [ ] **Step 4: Gates.**

Indexed from [README.md](README.md).
