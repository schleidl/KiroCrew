# Harness parity: Kiro first, everything else adapted

A *harness* is the agent process Kiro Crew drives over ACP. Kiro Crew has one
first-class harness — `kiro-cli` (`ACP_BACKEND_KIRO`, spelled `""`) — and a
growing set of adapted ones: Claude Code (`ACP_BACKEND_CLAUDE`), `KAS`
(`ACP_BACKEND_KAS`), Codex (`ACP_BACKEND_CODEX`), the remote AgentCore host
(`ACP_BACKEND_AGENTCORE`, registered but not baseline-selectable), and whatever a
bring-your-own (BYO) adapter registers next.

Kiro, Claude Code, KAS and Codex are selectable on a plain public build; Claude Code in
particular is a shipped harness and not a dormant seam: `acp/client.py` owns the
whole Claude spawn path and the adapter is a public npm package, so an earlier
revision that left it out of the baseline removed only the switch, never a
capability. Whether the binaries are INSTALLED on a given machine is a different
question, answered by `agent_sdk/backend_install.py`'s probe rather than by
selectability.

`BASELINE_SELECTABLE_BACKENDS` is otherwise `ACP_BACKENDS_KNOWN`, so an id this
core can spell is an id an operator can choose unless something states the
exception — pinned by
`test_agent_backend_editable.py::test_baseline_ships_every_known_backend`, which
guards against an undocumented NARROWING rather than a widening.
There is exactly one exception today: `NOT_SHIPPED_SELECTABLE` holds
`ACP_BACKEND_AGENTCORE`, the remote AgentCore harness, whose selectability needs
the `kirocrew[agentcore]` extra and the `capabilities.remote_exec` scope — see the
AgentCore section below. `ACP_BACKEND_CODEX` was the previous member and left it
once both halves landed — `backend_install.py` gained its probe, so the install row
names the missing component and its command instead of reading `unknown`, and
`acp_tool_gate` established that its tool calls reach the PreToolUse gate.

Read the invariants below against that tree: four harnesses can serve a real
session today, so a site that spells "kiro" by exclusion is already wrong on
three of them.

*Parity* here does not mean equal treatment. It means the opposite, stated
precisely: **an added harness may only adapt itself to the seams the Kiro
harness already runs through. It may not move, widen, generalize, or add a
branch to those seams.** A harness that cannot be adapted without changing the
Kiro path is not ready to land.

The failure mode this file exists to prevent is not a broken adapter — that
fails loudly on its own first session. It is the *silent capture* of the Kiro
path: a call site that spells "kiro" as `not is_<other>_backend`, so harness
number three inherits a capability, a sandbox waiver, or a session label that
nobody granted it, and the Kiro user who never chose another harness pays for it.
Two such sites shipped before this file existed
(`AcpProvider.is_session_sharing_eligible`, `AcpRuntime.spawn`'s
`is_kiro_cli`); both read as correct until you count the backends.

The transports these invariants constrain are specified in
[acp-client.md](acp-client.md) (framing, timeouts, the backend seam) and
[providers.md](providers.md) (the `LLMProvider` surface). The edition-level
registration seam is in
[platform-context.md](platform-context.md). This file only catalogs the
invariants and names what pins each one.

## How to read a row

- **Guarantees** is the property that goes RED when broken, not the
  implementation that happens to satisfy it today.
- **Pinned by** names the test module and function. Test modules live at `test/`
  in the repo root; sources live at `src/kiro_crew/`. A row marked
  *review-only* has no deterministic test — it is enforced by the
  `harness-parity` rule in `AUTOSDE.yaml`, which every AI review lane reads.
- An invariant is *closed* by its test, not by this document. If a row
  disagrees with the named test, the test is right.
- The ids are stable. Source docstrings and review findings cite them bare
  (`H4`, `H6`), so the id is the lookup key.

## Group A: Kiro is the default and the floor

These break by *addition*: a harness lands, nothing at these sites is edited,
and Kiro stops being the guaranteed path.

| Id | Guarantees | Pinned by | Constrains |
|---|---|---|---|
| H1 | `agent.acp_backend` defaults to `ACP_BACKEND_KIRO`, and `ACP_BACKEND_KIRO` is in `selectable_backends()` unconditionally. An operator who configures nothing, and an operator whose configuration is unusable, both get the Kiro harness. | `test_harness_parity.py::test_kiro_is_the_default_backend`, `::test_kiro_is_always_selectable` | `config/loader.py` (`AgentConfig.acp_backend`), `acp_backends.py` (`BASELINE_SELECTABLE_BACKENDS`) |
| H2 | A harness is chosen at `agent.acp_backend`. `agent.provider` stays `enum=["acp"]`: there is one provider and it is never the harness selector, because a second provider value would route around every invariant below. | `test_harness_parity.py::test_provider_enum_is_acp_only` | `config/loader.py` (`AgentConfig.provider`, `build_provider_factory`) |
| H3 | An unknown or unselectable persisted backend degrades to Kiro with a logged reason. It never raises and never survives — including the non-string shapes a hand-edited `config.json` can hold. Startup refusing with a reason is the contract; a stack trace or a silent foreign spawn is not. There is exactly ONE gate, and it reads `selectable_backends()` per call, so registering a backend is what makes a persisted value survive; the Kiro construction path gains no second check (H13). It must never read the platform context — `current_context()`'s lazy branch loads config and would re-enter the same load. | `test_harness_parity.py::test_unselectable_backend_degrades_to_kiro`, `::test_registering_a_backend_makes_it_survive_load`, `::test_config_load_never_reads_the_platform_context` | `acp_backends.py` (`resolve_selected_backend`), `config/loader.py` (`_normalize_acp_backend`) |
| H4 | Selectability has exactly ONE gate, and it logs. `AgentConfig.acp_backend` carries no static `enum`: a literal was frozen at import, before an edition registers a backend, and `validate_config_data` *deletes* an out-of-enum value before the loader sees it — so a registered preview harness was stripped from `config.json` with no degrade log at all. `resolve_selected_backend` is the gate; `GET /api/config/schema` supplies the live values the dashboard renders. | `test_harness_parity.py::test_selectability_has_one_logged_gate` | `config/loader.py` (`AgentConfig.acp_backend` metadata), `config/validation.py` (`validate_config_data`), `dashboard/handlers/agents.py` (`_supply_live_enum`) |

## Group B: identity is tested positively

The whole group is one rule with several faces: **no call site may express
"this is the Kiro harness" as the absence of another harness.** A negative test
is correct only while one harness can start, and it fails *open* — the other
harness is treated as Kiro. Four are selectable today, so `not
is_claude_backend` is not a rule waiting on a future harness to break it: it
already reads TRUE for KAS on a plain public build.

| Id | Guarantees | Pinned by | Constrains |
|---|---|---|---|
| H5 | Harness identity is a positive comparison against a named constant, or membership in a named set. `not is_claude_backend`, `!= ACP_BACKEND_KAS`, and `== "kas"` (bare literal) are all forbidden; `is_kiro_backend` and `backend in ACP_BACKENDS_<CAP>` are the forms. Enforced on the lines a change ADDS, not whole-tree — see the gate doc for why. | `scripts/check_harness_parity.py` (six rules, self-tested), `test_harness_parity.py::test_added_line_gate_self_test_passes`, `::test_added_line_gate_flags_a_planted_negative_test` | every module reading `AcpClient.backend` / `AcpProvider.is_*_backend` |
| H6 | A capability is granted by opt-in membership, never by negation. `is_session_sharing_eligible` reads `ACP_BACKENDS_SESSION_SHARING` and `supports_steer` reads `ACP_BACKENDS_STEER`, so a harness that has not demonstrated the capability does not inherit it from a set it was never added to. **Both drivers answer from the table, not one of them:** `AcpSessionHandle.supports_steer` reads it through the runtime's own backend id, because a constant that was true while `AcpRuntime` served a single host becomes a claim about the second host the moment one is added — and an advertised steer is met with `-32601` at the user's mid-turn correction. `store_session_config` is the same case for a model list: a host whose models arrive as a `model` select in `configOptions` rather than as a `models` object has them folded in by `session_models_envelope`, gated on `ACP_BACKENDS_ADVERTISED_MODEL_SELECTION` and read by BOTH the session-init capture and the entitlement probe, or its picker is empty on the runtime path while full on the client one and the probe cannot heal a degraded snapshot. **A COMPLETENESS gate backs all of these, because the per-site pins above only catch the sites that exist.** Two halves in `test_harness_parity.py`: every runtime-path per-host answer is asserted equal to its table for every backend in `ACP_BACKENDS_KNOWN` — not only for the hosts the site was written against, so a divergence is caught before a third host is admitted — and every backend-identity comparison in `acp/runtime.py` and `acp/session_handle.py` must appear in `_DECLARED_IDENTITY_TESTS` with a reason, so a NEW site answering from identity goes red until its author either points it at the table that already answers it or records why identity is honest there. The declaration list is pruned by its own test, so it cannot rot into a blanket pre-approval. One gate run answers for every site and every known host at once, which is what a per-site pin cannot do. Every *tuning channel* follows the same rule, one set per channel because a harness can implement one and not another: `ACP_BACKENDS_MODEL_VIA_CONFIG_OPTION` (model switch), `ACP_BACKENDS_EFFORT_VIA_CONFIG_OPTION` (effort push), `ACP_BACKENDS_MODEL_EFFORT_PAIR_IDS` (whether an advertised `<model>[<effort>]` id is applied as two config-option writes -- and, with it, whether a refusal of an advertised id reads as an adapter mismatch rather than an entitlement verdict), and `ACP_BACKENDS_KIRO_SLASH_COMMANDS` — membership in the last also decides who is sent `_kiro.dev/commands/execute` and who gets the workspace `cli.json` overlay written for them. A harness in none of these must not inherit a channel that answers `-32601`, nor collect an overlay it never reads and the membership-gated clear can never remove. `ACP_BACKENDS_MCP_CONFIG_HOT_RELOAD` follows the same rule for a *skip*: membership is what lets the dashboard's MCP sync leave running sessions alone after a config write, because the harness reconciles the agent file itself (kiro-cli, from the release its reconcile was verified on; `mcp_hot_reload.py` holds every live process to that floor, read from its own `initialize` handshake). A harness that never demonstrated the reconcile would otherwise have its users' freshly installed servers stay unmounted with nothing red to say why. `ACP_BACKENDS_POD_HOME_REMAP` is a further instance and the clearest illustration of why one set per capability matters: it decides whose pod-spawned child has its ambient `HOME` relocated so the harness's `$HOME`-derived OAuth grant store stays pod-scoped (`acp.client._apply_pod_home_remap`). Its membership is identical to `ACP_BACKENDS_INTERNAL_SANDBOX` today, and reusing that set would still be wrong — "carries its own OS sandbox" and "relocating `HOME` moves its credential store" are different properties, so a harness added there for sandbox reasons would silently inherit credential relocation it never opted into. A channel's option ID is a per-harness spelling rather than a membership question, so it is resolved through `effort_config_option_id(backend)` (default `effort`, `reasoning_effort` for codex-acp) and read at every effort site; a site naming one spelling writes an option the other adapter answers "unknown config option" to, which each caller reads as "no effort selector" and skips, so the failure is silent and the session runs a level the UI does not report. `ACP_BACKENDS_SIDE_READONLY` gates whether a Side Chat turn may execute read-only tools under `READ_ONLY` at all: the allowance rests on the derived `<agent>--readonly` kiro-cli spec, and another harness's own pre-approval surface is one the host gate cannot see, so off the set the side turn runs `REJECT_ALL` (see `side.md`). | `test_harness_parity.py::test_session_sharing_is_opt_in`, `::test_steer_is_opt_in`, `::test_model_switch_channel_is_opt_in`, `::test_effort_channel_is_opt_in`, `::test_only_overlay_readers_are_written_to`, `::test_mcp_config_hot_reload_is_opt_in`, `test_acp_pod_home_remap.py::TestTheCapabilitySetIsItsOwnDecision`, `test_acp_codex_harness.py::TestTheEffortChannelIsReadFromItsOwnTable`, `::TestWhatTheHandleAdvertisesForCodex`, `test_harness_parity.py::test_steer_advertisement_matches_the_steer_table`, `::test_agent_activation_by_mode_matches_the_routing_table`, `::test_the_model_select_fold_matches_the_advertised_selection_table`, `::test_unprojected_pooled_mcp_is_refused_for_exactly_the_mirrored_hosts`, `::test_every_runtime_path_identity_test_is_declared`, `::test_the_identity_test_declarations_are_all_still_live` | `providers/acp.py` (`AcpProvider.is_session_sharing_eligible`, `change_effort`, `clear_effort`, `_apply_initial_effort`, `_apply_effort_overlay`, `_apply_tool_search_overlay`, `stream_command`), `acp/client.py` (`AcpClient.supports_steer`, `_apply_pod_home_remap`), `acp/session_handle.py` (`AcpSessionHandle.supports_steer`, `store_session_config`, `models_from_config_options`), `acp_backends.py`, `mcp_hot_reload.py` (`mcp_hot_reload_supported`) |
| H7 | `is_kiro_cli` is a positive Kiro test at every call site. It drives internal-sandbox delegation: macOS skips Kiro Crew's seatbelt because Kiro's sandbox cannot nest inside it, and Windows permits the official Kiro backend to run despite having no Kiro Crew OS wrapper. Passed for a harness with no internal sandbox, it hands isolation to a layer that never starts; this is the only Group B row that is also a security invariant. **Windows requires `is_kiro_cli is True` exactly** — `None` and `_spawns_kiro_cli` basename inference can never grant the backend-less-host exception. On macOS a site may grant membership explicitly or pass `None` to defer to the positive basename test. | `test_harness_parity.py::test_is_kiro_cli_is_positive`, `test_sandbox_argv.py::TestKiroInternalSandboxExclusion` | `acp/runtime.py` (`AcpRuntime.spawn`), `acp/client.py` (`AcpClient.ensure_ready`), `sandbox.py` (`wrap_argv`, `_spawns_kiro_cli`) |
| H8 | New harness identifiers live in `agent_sdk/backends.py` — a LEAF module behind the agent-SDK boundary, so every consumer can name the constants rather than copy them — and are added to `ACP_BACKENDS_KNOWN`; every capability set is a subset of it; and `AcpProvider.__init__` rejects anything outside it. `ACP_BACKEND_KIRO` is the empty string, so a value that falls through every identity check spawns `kiro-cli` under a foreign label. `acp/types.py` and the `acp_backends` shim both re-export the vocabulary and remain import sites for existing callers. | `test_harness_parity.py::test_capability_sets_are_subsets_of_known_backends`, `::test_unknown_backend_rejected_at_construction`, `::test_codex_is_selectable_and_answerable` | `agent_sdk/backends.py` (`ACP_BACKENDS_KNOWN`), `providers/acp.py` (`AcpProvider.__init__`), `scripts/check_harness_parity.py` (`VOCABULARY_PATH`) |

`ACP_BACKENDS_MEMBER_CAPABILITIES` is the H6 opt-in for loading an enrolled
member's full saved agent spec. Only Kiro belongs today; this is separate from
session sharing and per-session member dispatch. Both `AcpProvider` and
`AcpSessionProvider` answer `member_capabilities_supported` from this set.
Support alone does not prove a template is loaded: dedicated runtime ownership,
liveness, active-mode confirmation, saved-version checks and MCP readiness still
apply. Pinned by `test_harness_parity.py::test_member_capabilities_are_opt_in`
and `test_session_capabilities.py::test_real_session_provider_member_support_is_explicit`.

## Group C: the Kiro path keeps its own machinery

An adapter that lands by *generalizing* a Kiro-specific step to a
lowest-common-denominator one has degraded the Kiro session even when every
test still passes.

| Id | Guarantees | Pinned by | Constrains |
|---|---|---|---|
| H9 | `kiro-cli` remains the default branch of spawn-argv resolution, keeping its pre-spawn agent materialization (`kiro-cli` discovers selectable modes from `~/.kiro/agents/*.json` at startup, so a later `set_mode` fails with "Mode not found" without it) and its `--model` pin (the only way to run a model outside the agent's provider). A refactor that treats Kiro as one entry among N drops both. The Kiro spawn lives in its own harness, so no other host shares the code that carries them. | `test_harness_parity.py::test_kiro_spawn_argv_keeps_its_own_branch`, `::test_codex_spawn_keeps_its_own_branch`, `test_acp_harness_contract.py::test_kiro_spawn_argv_names_the_agent_and_the_model` | `acp/harness/kiro.py` (`KiroHarness.resolve_spawn`) |
| H10 | Protocol version and client capabilities stay per-harness literals. Collapsing them to one handshake that every harness accepts silently downgrades the Kiro session's declared capabilities. The hosts also disagree on the protocol version's TYPE, so one shared handshake would break a host outright. | `test_harness_parity.py::test_handshake_is_per_backend`, `test_acp_harness_contract.py::test_protocol_versions_differ_in_type_not_just_value` | `acp/harness/kiro.py`, `acp/harness/kas.py` (`client_capabilities`, `protocol_version`), `acp/types.py` (`ACP_CLIENT_CAPABILITIES`, `KAS_CLIENT_CAPABILITIES`) |
| H11 | The provider label is a closed mapping and an absent label means Kiro. It indexes resume compatibility, session-map persistence, and session-file cleanup routing, so a harness with no `PROVIDER_LABEL_*` of its own persists as a Kiro session and its transcript is pruned for want of a Kiro session file. | `test_harness_parity.py::test_every_known_backend_has_a_label`, `::test_codex_carries_its_own_provider_label` | `acp/types.py` (`PROVIDER_LABEL_*`), `providers/acp.py` (`provider_label`, `cleanup_session`), `session.py` (`detect_provider_switch`) |
| H12 | Model pre-flight keeps "empty or unknown advertised set means allow", and never compares ids across harness namespaces. Harnesses advertise ids in their own spelling; one shared membership test across two namespaces calls every legitimate model unusable and withholds the model. | `test_harness_parity.py::test_model_preflight_allows_unknown_advertised_set` | `acp/client.py` (`model_is_unusable`, `advertised_model_ids`) |

## Group D: review-only invariants

Deterministically un-pinnable — they are properties of a change, not of a tree,
and the absence of a mechanism is not something a source scan can see. The
`harness-parity` rule in `AUTOSDE.yaml` carries them to every AI review lane.

| Id | Guarantees | Pinned by | Constrains |
|---|---|---|---|
| H13 | Harness support is additive at the `ProviderRegistry` seam: a v1 addition, no `CONTRACT_VERSION` bump. The Kiro construction path gains no conditional, no new required argument, and no new failure mode in service of an adapter. The shared-process runtime asks its host's harness per request rather than testing an identity, and Kiro's lookup into that table is TOTAL -- the id is a key of a literal beside the class it names, and the class takes no constructor argument -- so no ordinary session gains a way to fail before its process exists. | review-only (`AUTOSDE.yaml` → `harness-parity`), plus `test_acp_harness_contract.py::test_the_kiro_lookup_is_total`, `::test_the_runtime_resolves_the_kiro_harness_without_spawning` | `platform/interfaces.py` (`ProviderRegistry`), `config/loader.py` (`create_provider_factory`), `acp/harness/__init__.py` (`harness_for`) |
| H14 | A capability the session layer reads off a provider is declared on `LLMProvider` with a safe default. An adapter never forces a `hasattr` / `getattr` probe onto the Kiro path, and never leaves a Kiro-only attribute reachable through the ABC where a missing one reads as `False`. | review-only (`AUTOSDE.yaml` → `harness-parity`) | `providers/base.py` (`LLMProvider`), `providers/acp.py` (`AcpProvider`) |

## The CI half

The added-line gate that enforces Group B on a diff is
[../../ci/harness-parity-gate.md](../../ci/harness-parity-gate.md). The
structural invariants (Groups A and C) are pinned by
`test/test_harness_parity.py` and therefore fail in the ordinary test job, not
in a separate gate. Group D reaches the four AI review lanes through
`AUTOSDE.yaml`'s `harness-parity` rule, which every lane's prompt treats as the
source of truth for what blocks.

## The AgentCore remote harness, invariant by invariant

`ACP_BACKEND_AGENTCORE = "agentcore"` is the first host that does not run on the
operator's machine: the agent is a `kiro-cli acp` child inside a Bedrock AgentCore
Runtime microVM in the operator's own account, and the LOCAL argv is
`kiro_crew.agentcore.stdio_shim` — a byte relay whose stdin and stdout are the pipes
`AcpClient` already writes to and whose other end is one UNIX socket to a bridge in
the gateway process. Design:
[rfc-agentcore-remote-agents.md](../../request-for-change/rfc-agentcore-remote-agents.md).

Every invariant is answered here rather than in the PR body, because the id is
registered at fourteen sites and a reader auditing one of them needs to know which
invariant it was answering. Two answers are structurally new and are marked as such.

| Id | Answer for `agentcore` | Where |
|---|---|---|
| **H1** | Untouched, and asserted directly. `AgentConfig.acp_backend` still defaults to `ACP_BACKEND_KIRO`, and the remote id is absent from `BASELINE_SELECTABLE_BACKENDS`, so an operator who configures nothing gets Kiro and an operator who names `agentcore` on a plain build ALSO gets Kiro with a logged reason. The per-session executor override is inert when absent: with no `executor` the factory resolves the Kiro default unchanged. | `agent_sdk/backends.py` (`BASELINE_SELECTABLE_BACKENDS`, the exclusion comment); `test_agentcore_backend.py::test_the_id_is_known_but_not_baseline_selectable`, `::test_an_unregistered_id_degrades_rather_than_reaching_construction`, `::test_a_session_with_no_executor_still_resolves_the_kiro_default` |
| **H2** | `agent.provider` untouched, still `enum=["acp"]`. The remote host is selected at `agent.acp_backend`, or per session by the `executor` value that becomes what the one gate is asked about. No second provider, no `LLMProvider` presenting as the Kiro backend — which is the shape H2 exists to refuse and the RFC's own rejected alternative. | `config/loader.py` (`AgentConfig.provider`, unchanged); `test_harness_parity.py::test_provider_enum_is_acp_only` |
| **H3** | The same ONE gate, reached by a new INPUT rather than a new check. `members.select_provider_backend` gained an `executor` arm above the member-DM arm, and that arm calls the same `resolve_selected_backend` — so an unknown, misspelled or non-string executor degrades to Kiro with a logged reason instead of propagating to `AcpProvider`, which would raise. `agentcore` itself degrades on a plain build for exactly this reason, and `register_selectable_backend` is what makes it survive. Nothing here reads the platform context. | `members.py` (`select_provider_backend`), `agent_sdk/backends.py` (`resolve_selected_backend`, unchanged); `test_agentcore_backend.py::test_an_unselectable_executor_degrades_to_kiro` (5 shapes incl. `17`, `None`), `::test_registering_it_makes_the_one_gate_resolve_it` |
| **H4** | Still exactly ONE logged gate on the per-session path, and the count is asserted rather than argued: a patch on the re-export shim counts crossings of `resolve_selected_backend` for one provider construction and sees `[ACP_BACKEND_AGENTCORE]`. A second gate — an executor-specific coercion beside the existing one — shows up as a count of two. Scope stated honestly: this counts the per-session crossing only; the persisted-field crossing in `config/sections.py` binds the function at module import, always existed, and answers a different question. | `test_agentcore_backend.py::test_the_gate_is_reached_exactly_once` |
| **H5** | Every identity comparison added is positive against a named constant: `AcpProvider.is_agentcore_backend` and the `provider_label` branch both read `backend == ACP_BACKEND_AGENTCORE`. No inequality, no bare literal, no `not is_<other>_backend`. The temptation here is concrete and named in the source: the remote child IS kiro-cli, so answering True to `is_kiro_backend` would look reasonable and would hand a remote session every local-process assumption Kiro's path carries. | `providers/acp.py` (`is_agentcore_backend`, `provider_label`); `scripts/check_harness_parity.py` (added-line gate), `test_acp_backend_kas.py::TestBackendPredicates` (exactly one predicate holds) |
| **H6** | **An explicit NON-MEMBERSHIP decision for every Group B set**, recorded as one block beside the sets rather than inferred. The answer is "no" to all of them, and the reason is nearly always the same: the remote child is kiro-cli and WOULD answer most of these, but the channel is one socket through a single-turn worker session, so a capability claimed here is a capability asserted about the BRIDGE, which WP3 has not built. Three are load-bearing rather than merely unmeasured — `ACP_BACKENDS_SESSION_SHARING` (the dedicated arm is the only arm that reaches the factory where the gate lives), `ACP_BACKENDS_HOST_AUTH_CALLBACK` (a security decision: the peer on the socket is a bridge, not a process Crew spawned), and `ACP_BACKENDS_HARNESS_OWNED_SESSIONS` (a single-turn session is gone at `done`, so a remote session id must not read as resumable). | `agent_sdk/backends.py` (the `ACP_BACKEND_AGENTCORE`'s capability decisions block); `test_harness_parity.py::test_capability_sets_are_subsets_of_known_backends` and the Group B completeness gate, which answers for every known host at once |
| **H7** | Untouched, and untouchable from here: `is_kiro_cli` stays a positive Kiro test, and the remote id is outside `ACP_BACKENDS_INTERNAL_SANDBOX`, so no seatbelt skip and no Windows delegation is granted. The container's own microVM plus its privilege drop to a non-root uid is a stronger boundary than either, and it is deliberately NOT expressed as membership in that set: the set governs whether Crew SKIPS its own wrap for the LOCAL argv, and the local argv is a byte relay Crew wraps like any other child. Membership fails open, so it is never claimed on a guarantee that lives on another host. | `sandbox.py` (unchanged), `agent_sdk/backends.py` (`ACP_BACKENDS_INTERNAL_SANDBOX`, non-membership recorded); `test_harness_parity.py::test_is_kiro_cli_is_positive` |
| **H8** | The constant is DEFINED in `agent_sdk/backends.py`, the leaf module behind the agent-SDK boundary, and re-exported by the `acp_backends` shim and `acp/types.py` for existing importers — no second definition anywhere, which the parity gate's `vocabulary-home` rule enforces on added lines. It is in `ACP_BACKENDS_KNOWN`, every capability set remains a subset of that, and `AcpProvider.__init__` accepts it because of that membership rather than by a special case. | `agent_sdk/backends.py` (`ACP_BACKEND_AGENTCORE`, `ACP_BACKENDS_KNOWN`), `acp_backends.py` / `acp/types.py` (re-export only); `test_agent_sdk_capabilities.py::test_known_membership_is_unchanged_by_the_move`, `test_harness_parity.py::test_capability_sets_are_subsets_of_known_backends` |
| **H9** | Untouched. `KiroHarness.resolve_spawn` keeps its own branch, its pre-spawn agent materialization and its `--model` pin; nothing was generalized to accommodate a host with no binary. `AgentCoreHarness` is a separate class whose argv shares no code with it, and it resolves its own coordinates through its own patchable function so the universal "no harness returns an argv it cannot launch" invariant can be asserted against it. | `acp/harness/kiro.py` (unchanged), `acp/harness/agentcore.py` (`resolve_spawn`, `_resolve_runtime_coordinates`); `test_harness_parity.py::test_kiro_spawn_argv_keeps_its_own_branch`, `test_acp_harness_contract.py::test_a_missing_binary_aborts_the_spawn[agentcore]` |
| **H10** | Its own per-host literals, and the temptation to share Kiro's is explicitly refused in the source. `protocol_version` is the INTEGER `1`, not kiro-cli's date-stamped `2025-08-22`, even though the remote child is kiro-cli: Spike C observed an integer on this wire and the worker forwards `initialize` rather than asserting a version. `client_capabilities` is `{}` because every capability Crew advertises here is a promise about what the BRIDGE answers. | `acp/harness/agentcore.py` (`protocol_version`, `client_capabilities`); `test_harness_parity.py::test_handshake_is_per_backend`, `test_acp_harness_contract.py::test_protocol_versions_differ_in_type_not_just_value` |
| **H11** | `PROVIDER_LABEL_AGENTCORE = "agentcore"`, its own entry in the closed mapping. This is the invariant the remote host is most exposed to, and the source says why: the label indexes session-map persistence and session-file cleanup, so reusing the kiro label — tempting, because the child IS kiro-cli — would persist a remote session as a Kiro one and the map would prune its id for want of a local kiro transcript that was never written on this machine. | `acp/types.py` (`PROVIDER_LABEL_AGENTCORE`), `providers/acp.py` (`provider_label`); `test_harness_parity.py::test_every_known_backend_has_a_label` |
| **H12** | Untouched, and kept safe by a namespace rather than by a comparison. The remote id gets its own `_MODEL_REGISTRY_NAMESPACE_BY_BACKEND` key instead of sharing kiro's `acp` bucket: the ids the remote child advertises are the same SPELLING as the local ones, but the entitlement behind them is the container's credential rather than the operator's, so folding the two would let one picker overwrite the other. No model id is hardcoded anywhere — the default stays `"auto"`, and the id is outside `ACP_BACKENDS_MODEL_VIA_CONFIG_OPTION`, so no pre-flight comparison runs for it at all. | `agent_sdk/backends.py` (`_MODEL_REGISTRY_NAMESPACE_BY_BACKEND`, `model_registry_namespace`); `test_harness_parity.py::test_model_preflight_allows_unknown_advertised_set` |
| **H13** | Additive, `CONTRACT_VERSION` unchanged at 1. The Kiro construction path gains **no conditional and no new required argument**: `executor` is optional on the factory closure and defaults to `None`, and it was already being accepted silently by the closure's `**_kwargs` sink before it was named — so naming it added a parameter and no plumbing. An empty or absent executor falls through untouched. Kiro's harness lookup stays total. **New, and the reason this row is not a formality:** the dedicated arm is FORCED at `subagent_manager/run.py` rather than merely arrived at. `is_session_sharing_eligible` being false for the remote harness and the shared-runtime branch's local-provider type check both push a remote session there, and NEITHER is sufficient, because `use_session_sharing` is computed from the SPAWN's eligibility before any harness exists: an executor passed to a sharing-eligible spawn would ride `extra_kwargs` to a factory the shared arm never calls, and the run would come up on the parent's harness with nothing red to say so — a wrong answer, not an error. | `config/loader.py` (`create_provider_factory`, the `executor` parameter), `subagent.py` (`SubagentInfo.executor`), `subagent_manager/run.py` (the forced arm), `acp/harness/__init__.py` (`harness_for`); `test_agentcore_backend.py::test_an_executor_forces_the_dedicated_arm_explicitly`, `::test_the_run_path_carries_the_executor_on_the_existing_pass_through`, `test_acp_harness_contract.py::test_the_kiro_lookup_is_total` |
| **H14** | No `hasattr` / `getattr` probe was added to any path. The one capability the session layer reads off this provider is `is_agentcore_backend`, a declared property on `AcpProvider` beside the four existing ones, so the absent case is a real `False` rather than a missing attribute. Nothing Kiro-only became reachable through the ABC. Review-only, so this row is a statement of what a reviewer should check rather than a test citation. | `providers/acp.py` (`is_agentcore_backend`), `providers/base.py` (unchanged); review-only (`AUTOSDE.yaml` → `harness-parity`) |

Two answers above are structurally new and worth carrying forward rather than
reading as bookkeeping.

**H13's forced arm is the finding, not the detail.** Every earlier per-spawn
override (`model`, `reasoning_effort`) forces the dedicated arm for an efficiency
reason: the parent's runtime was started with the parent's model and cannot switch
per session. For an executor the reason is categorical — the parent's shared runtime
is a process of the parent's own HARNESS — and the failure mode if the branch is
missing is a silent downgrade rather than an ignored preference. That is why the test
pins the branch on the run path's source instead of inferring it from
`ACP_BACKENDS_SESSION_SHARING` non-membership, which would pass while the branch was
deleted.

**H1's exception is the first real use of `NOT_SHIPPED_SELECTABLE`.** The allowlist
had been empty since it was written, and the healthy reading of that was "every id
this core can spell, an operator can choose". This id cannot be, and the reason is
not "unfinished": selectability needs the `kirocrew[agentcore]` extra, which is what
puts a bridge behind the shim's socket, and the `capabilities.remote_exec` scope,
whose capability default is false. Offering the switch would render an option whose
every session stalls at the ACP handshake with nothing listening on the far end of
the socket — the "an option that cannot start a session" state
`register_selectable_backend` exists to prevent. The edition that ships the extra
calls that function, so spellable-and-unreachable is a property of the registration
seam rather than of a narrowing somewhere downstream.

One thing the invariants do NOT cover, stated so a reader does not look for it here:
the local process this harness spawns is a byte relay, and what keeps it from being a
general-purpose tunnel is its own contract — it binds and accepts exactly ONE
connection, never dials out, holds no credential, and refuses a peer that cannot
present the session's owner token. That is a security property of
`kiro_crew/agentcore/stdio_shim.py`, pinned by `test_agentcore_stdio_shim.py`, not a
harness-parity invariant.

### The bridge behind the socket

`kiro_crew/agentcore/bridge.py` is the other end of the relay's socket, and the
division of labour is the point: the shim BINDS and listens, the bridge DIALS and
presents the owner token as one newline-terminated line. That order is not
arbitrary — the shim owns the node's permissions (it binds under `umask(0o077)` and
closes its listener after exactly one accept) and the bridge owns the coordinates it
minted, so neither derives what the other chose. A dial that fails with ENOENT is
therefore expected while `AcpClient` is still starting the relay, and retried; the
bridge is the side that carries the retry because the shim has no dial-out path at
all.

Three behaviours are the bridge's alone, and each is a client obligation the worker
does not discharge:

- **The sequence watermark.** The worker guarantees monotonicity and gap
  announcement, never single delivery, so duplicate suppression lives here. A
  replayed event at or below the watermark is dropped silently; a `history_gap`
  ADVANCES the watermark to its `throughSeq`; `attach_end` never advances it,
  because it describes one attach rather than the session.
- **One resume path.** `start` answers 409 on an existing session, so a dropped
  stream is recovered by polling the read-only `attach` action and never as a live
  stream again. The loop ends on a terminal event or on `attach_end.live == false`,
  the second because a session whose terminal event was pruned would otherwise be
  polled forever.
- **Delivery is not assumed.** A failed `rpc` answers 409 and an unparsable answer
  counts as undelivered; both queue the message for re-send after the next
  re-attach, which is safe because a JSON-RPC id is idempotent at the child.

Two constraints a reader should not have to rediscover. The AWS SDK is imported
INSIDE the method that needs it, so a public install without the `agentcore` extra
never imports boto3 — pinned in a subprocess with the import blocked, the same
pattern `test_approval_chain_no_cryptography.py` uses. And the relay's socket path is
bounded: `sockaddr_un.sun_path` is 104 bytes on macOS, so the filename carries a
16-character slug of the session id rather than the whole 41-character id and
`socket_path_for` refuses a path over the limit with a message naming it. Overrunning
it otherwise surfaces as `OSError: AF_UNIX path too long` from inside asyncio at spawn
time, which names neither the cause nor the fix.

Liveness is `kiro_crew/agentcore/liveness.py` and answers a different question from
the local one on purpose. The relay's pid exists, and handing it to the CPU-sampling
oracle would be wrong twice: a byte relay's CPU is flat while the agent is at its
busiest, which reads as wedged, and it stays alive after the container is gone, which
reads as healthy. So silence against the worker's own keepalive interval is the
observable, `runtime_info()` answers `(None, None)`, and the existing oracle's
`check_model_wait(None)` already returns `unknown` rather than `dead` — no change was
needed there, which is why this is a declaration rather than a subsystem.

## Adding or changing an invariant

1. Write the test first: an invariant is its test, and this table is the index.
   A row whose *Pinned by* cell names nothing is a wish.
2. Cite the id in the source docstring it constrains, and add the row here in
   the same change.
3. Never relax a check to make a red invariant green. A parity failure that
   flips GREEN because the Kiro path was made to match the adapter is the
   regression this file exists to catch, not a fix. If a harness genuinely
   cannot be adapted within these invariants, the correct outcome is that the
   harness does not land yet — say so in the PR instead of widening a seam.
4. A new harness adds rows to `ACP_BACKENDS_KNOWN`, a `PROVIDER_LABEL_*`, and
   an explicit decision for every Group B membership set. "Inherited the
   default" is not a decision. `BASELINE_SELECTABLE_BACKENDS` is otherwise
   `ACP_BACKENDS_KNOWN`, so leaving a known id out of the baseline is a
   NARROWING that `test_baseline_ships_every_known_backend` fails on **unless**
   the id is named in that test's `NOT_SHIPPED_SELECTABLE` allowlist together
   with the reason it cannot be offered yet: the id becomes spellable but
   unreachable, and that state needs a stated reason rather than a default.
   The allowlist holds `ACP_BACKEND_AGENTCORE` today, and the section below is
   the worked example of what that reason has to look like. The full sequence a
   new harness walks, and which stage decides whether it lands dormant or
   selectable, is [harness-onboarding.md](harness-onboarding.md).
