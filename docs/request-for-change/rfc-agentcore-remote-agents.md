---
title: AgentCore Remote Agents — run a kiro-cli agent on Bedrock AgentCore and render it as a local subagent
status: draft
author: dschlei
created: 2026-09-14
last-audited: 2026-09-14
audited-at: c719ef81a
doc-pr:
implementation-prs: []
tracking-issues: []
supersedes: []
superseded-by: []
---

# RFC: AgentCore Remote Agents

## Summary

Let a Kiro Crew session spawn a coding agent that executes on **Amazon Bedrock
AgentCore Runtime** in the operator's own AWS account, and show that agent in the
dashboard exactly like a local subagent — same run card, same live text and tool
stream, same steer and stop controls, same `[Subagent completion event]`, same
transcript on disk.

The remote agent is a `kiro-cli` process inside an AgentCore container. It speaks
the same ACP JSON-RPC it speaks locally. Kiro Crew reaches it through a new
`agent.acp_backend` id whose harness spawns a **local stdio shim**; the shim
forwards newline-framed JSON-RPC over a per-session UNIX socket to a **bridge
that lives in the gateway process** and translates to AgentCore
`InvokeAgentRuntime` plus a server-sent event stream.

Nothing about the subagent pipeline changes. Because the remote session is
obtained through `SessionManager.get_or_create` like any dedicated-process
subagent, the registry, the `subagent_*` websocket frames, completion injection,
`result.txt`, steer and stop all work unmodified. The visible additions are a
badge, a region and a credit counter.

The feature is opt-in, default-off, and public core never imports an AWS SDK: the
bridge lives behind the `kirocrew[agentcore]` extra and a
`capabilities.remote_exec` governance scope.

## Motivation

### Current state (verified at `c719ef81a`)

- Kiro Crew owns delegation and none of remote execution. `SubagentManager`
  admits, spawns, streams, reaps and injects (`src/kiro_crew/subagent.py`,
  `src/kiro_crew/subagent_manager/`), but every session ultimately drives a local
  `kiro-cli` child.
- The ACP transport is a subprocess pipe. `AcpClient` and `AcpRuntime` write
  newline-framed JSON to `self._process.stdin` and read `stdout` directly; there
  is no stream-pair seam to inject a socket into.
- The harness seam, by contrast, is argv-only: `SpawnPlan.argv` built from
  `SpawnContext` by `HarnessAdapter.resolve_spawn` (`src/kiro_crew/acp/harness/`).
  A backend whose harness returns a different argv needs no transport change.
- AgentCore exists in the tree only as governance and validation scaffolding:
  `platform/agentcore_schema.py`, the `capabilities.agentcore` scope, the
  `AgentIdentityProvider` protocol with an empty default, and the pre-emptively
  fenced `agentcore-inbound` credential directory. Nothing invokes AgentCore.
- Existing remote compute is a peer gateway: `cloud/` provisions a second full
  Kiro Crew on the operator's EC2 instance and reaches it over SSM. There is no
  job queue, no task submission and no result contract for a remote *agent*.
- The dashboard already models remoteness for that peer case:
  `SlotProjection.to_dict` carries `executor` and `instance_id`, and
  `cloud/remote_relay.py` replays a peer's stream into a local slot so that
  "every existing frontend consumer sees exactly the frames a local turn
  produces". That is the pattern this RFC follows.

### Problems

1. A long or expensive coding run occupies the operator's laptop. Concurrency is
   bounded by local memory (`compute_max_subagents`), and closing the lid ends
   the work.
2. Untrusted repository code runs on the operator's own machine with the
   operator's own uid. A per-session microVM is a stronger boundary than a
   sandbox profile.
3. There is no way to give one delegated run its own credential scope: an
   eligible subagent shares the parent's process, so it shares its environment.

### Why now

`kiro-cli` supports headless operation with an API key, so an agent can run
without an interactive login. AgentCore Runtime provides per-session microVMs,
which is the isolation shape a coding agent on untrusted code wants.

## Goals

1. `spawn_run(task=…, executor="agentcore")` runs the agent remotely and returns
   its result through the existing completion path.
2. The remote agent is indistinguishable from a local subagent in the dashboard,
   plus an explicit remote badge, region and credits so the operator knows where
   it runs and what it costs.
3. Steer and stop work on a remote agent.
4. A remote run survives a dropped stream, including AgentCore's streaming
   ceiling, without losing or duplicating events.
5. Default-off. A standalone install without the extra behaves exactly as today.
6. The model credential for the remote agent never reaches the operator's machine
   and never reaches any agent's context.

## Non-goals

- Kiro Crew does not become an AWS deployment tool. Provisioning stays a
  human-only action, consistent with `assert_human_action` in `cloud/aws.py`.
- No second `agent.provider`. It stays `enum=["acp"]`; harness parity invariant
  H2 exists precisely to stop a remote path from routing around the invariants.
- No new `LLMProvider` implementation presenting as the Kiro backend.
- No change to `CONTRACT_VERSION`.
- Not a managed service. There is no Kiro Crew-hosted control plane; the runtime
  lives in the operator's account.
- Not a replacement for cloud mode's peer dashboard, which stays what it is.

## Design

### Target architecture

```
gateway process (local)                        operator's AWS account
┌──────────────────────────────────┐           ┌──────────────────────────────┐
│ SubagentManager (unchanged)      │           │ AgentCore Runtime (arm64)    │
│  → SessionManager.get_or_create  │           │  worker: HTTP /ping           │
│  → AcpClient(argv = stdio shim)  │           │          /invocations → SSE   │
│        │ newline JSON-RPC        │           │   ├ bounded seq-stamped hub   │
│        ▼ UNIX socket             │  Invoke   │   ├ owner-token guard         │
│  AgentCoreBridge                 │◄─Agent────┤   ├ git clone, GIT_ASKPASS    │
│   invoke / attach(sinceSeq)      │  Runtime  │   ├ privilege drop to a       │
│   stop escalation                │  + SSE    │   │   non-root uid            │
│   boto3 (extra), consented       │           │   └ kiro-cli acp child;       │
│   profile, no agent env          │           │      stdout lines → SSE       │
└──────────────────────────────────┘           └──────────────────────────────┘
```

### Why a backend id and not a provider

Three shapes were possible. Only one survives the invariants.

| Shape | Verdict |
|---|---|
| New `LLMProvider` presenting as the Kiro backend | Rejected. H2 pins `agent.provider`; H5 forbids identity by absence; H11's provider-label map is closed. |
| Keep ACP local, relocate only tool execution | Rejected. The model turn stays local, so the agent does not run remotely. It answers a different question (blast radius), not this one. |
| New `acp_backend` id, harness returns a bridge argv | **Chosen.** Additive at the documented seams, no transport rewrite, `AcpRuntime` demux and the tool gate untouched. |

The new id resolves `Routing` to its `AGENT_SPEC` member. Spike B established that
the dichotomy this RFC first asserted — "session-config or stronger, because an
unlisted id resolves unverified" — is wrong in both halves: `UNVERIFIED` is
forbidden outright for a registered harness, and *every* non-`AGENT_SPEC` member
obliges a credential mask, a sandbox-tier consult and, when enforced, a credential
leaf plus its own preflight arm inside the ACP client's spawn path. `AGENT_SPEC` is
the accurate member for a remote agent selected by name, and it incurs none of
that. Identity stays positive (`is_kiro_cli` literal true, membership in named
sets); no capability is expressed as the absence of another harness.

Registering an id is not a one-line change. Spike B measured the real bill at
fourteen sites, each pinned by a loud test: the constant and known set, the policy
id, the provider label, the model namespace, the install probe, the host-auth
declaration, the harness class, a provider predicate, a frame-replay corpus
covering seven frame classes, a projections declaration, nine columns in the
host-contract table, and an onboarding paragraph. None can be forgotten, and none
can be skipped. That cost belongs to WP2 and is entirely separable from the
executor override.

### Where the credential lives

The agent's own child environment is scrubbed of credential-shaped variables in
every sandbox mode, and exporting a *pointer* to a credential is itself the leak
the security spec forbids. Therefore:

- The shim carries no credential. It knows a socket path and nothing else.
- The bridge signs AgentCore calls in the gateway process using a profile the
  human consented to through `aws_consent.py`, which re-verifies the account id
  live.
- The agent's model credential (`KIRO_API_KEY`) exists only in AWS Secrets
  Manager and in the worker container's memory. It is never on the operator's
  disk, never in a Kiro Crew config file, and never in any agent context. The
  vault's `secret_env` pattern — env-var name to secret name, plaintext resolved
  only in the runner — is the precedent.
- The runtime ARN, region and endpoint qualifier are trust-root data, so they
  live on the keystone (`agentcore_runtime.json`) as a read-only leaf, not in
  agent-writable `config.json`. Every keystone leaf carries exactly one
  disposition and the disposition pin test enumerates them.

### The worker contract

One AgentCore session per remote agent. `runtimeSessionId` is at least 33
characters. Every action carries an owner token minted per session by the bridge,
so knowing a session id is not enough to drive it.

| Action | Direction | Meaning |
|---|---|---|
| `start` | client → worker | Clone the repo, drop privileges, launch the agent child, stream. |
| `rpc` | client → worker | Deliver one JSON-RPC message to the child's stdin. Answers `{delivered: true, seq}` naming the sequence number the delivery was observed at, so a client that reconnects mid-approval can tell a delivered message from a dropped one. |
| `attach` | client → worker | Read-only replay of everything after `sinceSeq`, then end. |
| `stop` | client → worker | Cancel the turn, then terminate the child. |

The worker emits server-sent events, each stamped with a monotonic per-session
sequence number — with one deliberate exception, `attach_end`, below — drawn from
`acp` (one raw JSON-RPC message from the child), `status`,
`usage`, `history_gap`, `attach_end`, `error` (with a `fatal` flag), `done`, and a
comment keepalive.

A **session is single-turn**, decided during WP1. A prompt that returns a
`stopReason` emits `status/turn_end`, then `done`, then the child is terminated.
`done` is therefore per session and genuinely final, which is what keeps an idle
container from costing money with nobody attached. The consequence is a real
constraint on WP3 rather than a detail: continuing a finished remote run cannot
resume the same agent, so a follow-up needs a new session seeded with a summary,
and the container's own context is gone. Keeping the child alive between turns
behind an idle timeout would buy multi-turn continuation at the price of paid idle
time; it is deferred, not rejected, and nothing in the contract forbids adding it
later.

A **rejected action never opens a stream it is about to abandon.** A short session
id, an unknown session, a wrong owner token or a breached concurrency cap answer an
HTTP status (400, 403, 404, 409, 429) carrying the single result shape. The
reference implementation half-opened an event stream and wrote a fatal `error` into
it; a client then has to parse a stream to learn it was refused.

Four rules the reference implementation leaves implicit and this one states:

- **Deduplication is the client's obligation, not a worker guarantee.** Two
  concurrent invocations on one session may each legitimately replay the same
  range; only the client's sequence watermark keeps the transcript clean. Spike C
  observed exactly this during a stop.
- **`attach` ends with an `attach_end {live, lastSeq}` sentinel**, because "the
  response ended" otherwise cannot be told apart from "the session is over". It is
  the **one event carrying no sequence number**: it describes *this* attach rather
  than the session, so stamping it in the shared sequence space would advance every
  other client's watermark past an event they never received.
- **A fatal `error` terminates the child** before the stream closes. Otherwise a
  container keeps running, and keeps costing, with nobody attached.
- **`usage` is advisory and never the billing record.** Per-turn credits already
  arrive inside `acp` messages; a client that sums both double-counts.

History is bounded and announces its own gap with `history_gap` when it prunes, so
a client never silently believes it saw the whole transcript. Terminal events are
never pruned.

The agent child negotiates its own protocol version and it need not match what a
local Kiro Crew session negotiates — Spike C saw an integer where the local client
sends a date string. The worker forwards `initialize` rather than asserting a
version.

**Resumability.** A stream that ends or throws *without* a terminal event is a
transport drop, not a dead agent. The bridge marks the run reconnecting and polls
`attach(sinceSeq)` until a terminal event arrives; only a fatal error ends the
loop. This is how the streaming ceiling is handled — no timeout is tuned, and no
event is lost or replayed twice.

The poll interval is a declared constant, not an implementation detail, because it
sets the worst-case latency of a tool approval: an approval answered on a live
stream costs about ten milliseconds, and the same approval answered while
reconnecting costs one poll interval. Spike C measured a fifty-fold difference at
a 500 ms interval. The interval therefore trades reconnect chattiness against how
long a remote agent sits waiting for a permission it has already been granted.

**The constant is 3000 ms**, matching the cadence the reference implementation runs
in production, overridable per deployment. Two consequences follow from naming it
rather than leaving it to the bridge. An approval that arrives while the stream is
down is delayed by up to one interval, so a run that is dropping repeatedly feels
slow at the tool gate rather than at the model — worth saying in a status line
instead of leaving the user to guess. And each tick is a billed invocation, so
shortening the interval to chase approval latency raises cost on every reconnect,
which is the wrong lever: the right fix for a chronically dropping stream is fewer
drops, not faster polling.


### Rendering as a local subagent

The remote session is a dedicated-arm session, and the arm is **forced
explicitly** rather than merely arrived at. `is_session_sharing_eligible` returning
false and the shared-runtime branch's type check for the local ACP provider both
push it there, but Spike B showed that relying on that is a bug: an executor passed
to a sharing-eligible spawn is otherwise silently ignored, which is a wrong answer
rather than an error. With the arm forced, the existing pipeline carries it: text
chunks reach `write_result_chunk` and `result.txt`, tool calls and permission
requests reach the same gates, the four terminal guards arbitrate completion, and
`_on_done` injects the completion event into the parent slot.

Local-process assumptions degrade rather than break. `runtime_info()` returns no
pid and a remote identifier; pid-liveness orphan reconciliation, descendant-tree
stall attribution and resource sampling take their documented unknown paths, and
liveness comes from the worker's own heartbeat.

The additive UI surface is three fields on the spawn and snapshot frames plus the
slot projection — an executor kind, a region and accumulated credits — one new
frame for usage, and a badge in the run card and the agents panel.

### Governance and safety

- `capabilities.remote_exec` is a new scope catalog row, capability-default
  false, enforced fail-closed and audited at spawn admission. Adding it is a data
  change plus a matcher, with no evaluator edit.
- Provisioning the runtime, writing the secret and any other AWS mutation stay
  human-only and off the tool surface.
- The stdio shim is not a general tunnel: it accepts one connection from one
  session and refuses a mismatched owner token.
- Remote transcripts are archived by the worker to the operator's own bucket and
  are additionally written locally as the usual subagent transcript.

## Migration plan

Each phase is one pull request unless noted. Phase 0 is a throwaway spike branch.

- **Phase 0 — spikes.** Prove (a) `kiro-cli acp` runs headless in an arm64
  AgentCore container, (b) a per-session executor override passes through the
  single backend-selection gate without adding a second gate, (c) bidirectional
  JSON-RPC over invoke plus SSE, including a permission round-trip and a forced
  drop resumed by `attach`. Verdicts land in this document's open questions.
- **Phase 1 — worker and infrastructure.** The container and the account
  resources. Reuses the reference implementation's agent-agnostic modules.
- **Phase 2 — backend id, harness, shim, keystone leaf, governance scope.**
  Public no-ops until the bridge exists.
- **Phase 3 — the bridge**, developed and tested entirely against a fake worker,
  so it does not wait on an AWS deployment.
- **Phase 4 — spawn surface**: the `executor` argument on the tool, the HTTP
  route, the slot route and the CLI twin.
- **Phase 5 — UI extras**: badge, region, credits, composer toggle.
- **Phase 6 — delivery and durability**: repository delivery from the worker, and
  re-attach to a live remote run after a gateway restart.

The task-by-task plan is
[`plans/2026-09-14-agentcore-remote-agents.md`](plans/2026-09-14-agentcore-remote-agents.md).

## Alternatives considered

**Wrap the reference implementation's worker protocol as-is.** Its events are the
other agent's message shapes, so Kiro Crew would translate twice and lose the
tool gate's fidelity. Carrying raw ACP messages instead means the local gates see
exactly what they see locally.

**Run the agent through cloud mode's peer gateway.** That already exists, but it
provisions a whole second Kiro Crew and presents as a peer dashboard, not as a
delegated agent inside one session. It also cannot give one run its own
credential scope.

**A managed multi-tenant runtime.** Out of scope by the project's own deployment
model: state and model traffic stay on hardware the operator controls.

## Open questions

Phase 0 ran on 2026-09-14. Verdicts are recorded below; the evidence lives outside
this repository, next to the runnable package specs, because it names
account-specific coordinates.

1. **Does ACP mode accept API-key authentication?** ANSWERED 2026-09-15: yes, and
   this was the design's largest open risk. With only `KIRO_API_KEY` in the
   environment and an empty home directory, the ACP child completed `initialize`,
   `session/new` and a full `session/prompt` turn, reported per-turn credits, and
   closed with `stopReason: end_turn`. No interactive login was attempted. A control
   run with the key removed and everything else identical failed at `initialize`
   with "You are not logged in", which is what proves the key was load-bearing
   rather than some other credential satisfying the request. ACP mode therefore
   fails fast without a credential instead of falling back to a device login, so the
   worker needs no login-suppression flag. The fallback of driving one
   non-interactive turn at a time is not needed, and mid-turn steering and
   interactive approvals survive.

   One container requirement fell out of it: the launcher resolves its sibling at
   `$HOME/.local/bin/kiro-cli-chat`, so the image must place that binary under the
   agent user's own home or the process fails before authentication is ever reached.
   The draft image's guess about a writable agent home is now a confirmed
   requirement.
2. **Approval latency.** ANSWERED by Spike C. The input invocation itself is
   sub-millisecond on loopback and an approval on a live stream round-trips in
   about ten milliseconds; while reconnecting it costs one poll interval, which was
   fifty times more at 500 ms. The conclusion is not "approvals are slow" but "the
   poll interval is a latency budget", which is why the contract above declares it.
   The remaining unknown is the invocation's own cost against the real service,
   which no local spike can measure.
3. **Whether the worker runs the agent's own sandbox in addition to the uid drop.**
   OPEN. Unchanged by Phase 0.
4. **Cost reporting granularity.** Partly answered: per-turn credits are real and
   arrive inside the agent's own messages, so the advisory `usage` event must not
   be summed alongside them. Platform compute cost remains visible only through
   account budgets.
5. **Per-session executor selection.** ANSWERED by Spike B: PASS. The single gate
   is `resolve_selected_backend`, with four pre-existing executable callers. The
   carrier is a value on the same keyword pass-through that a per-spawn model and
   reasoning effort already ride — subagent info, to the extra keyword arguments,
   to session creation (which already forwards them verbatim), to the
   provider-factory closure, where the executor simply becomes what the one gate is
   asked about. Six sites, no new mechanism, and a counting patch proved exactly one
   gate crossing per construction. A session with no executor still resolves the
   Kiro default unchanged, and a bogus executor degrades through the same coercion.
   H3, H4 and H13 hold; H9 is untouched; every added identity comparison is
   positive. The test failed with the carrier reverted and passed with it restored;
   the parity gate is green over 782 added lines, with a clean type check and lint.
   WP4's shape therefore stands as designed, and the fallback is not needed.

