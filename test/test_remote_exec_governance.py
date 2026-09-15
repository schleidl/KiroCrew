"""``capabilities.remote_exec`` — the catalog row and its spawn-admission gate.

Three properties are pinned here, and each one is a way a remote spawn could
otherwise happen unasked:

* the scope is a CATALOG DATA row with a false capability default, added with no
  evaluator branch (``resolve`` never learns the name);
* a policy that does not AFFIRMATIVELY grant it refuses a remote spawn — omission
  included, which is where the evaluator's own ungoverned-is-permitted contract
  and this consumer deliberately part company;
* the refusal is a refusal. The member is never re-tried locally, because running
  untrusted work on the operator's own machine is not a narrower answer to "run
  this somewhere else" than the request carried.

The keystone leaf that carries the runtime's coordinates is pinned separately, in
``test_sandbox_governance_mask.py`` — that file owns the disposition union.
"""

from __future__ import annotations

import dataclasses
import inspect
import json
from unittest.mock import MagicMock, patch

import pytest

from kiro_crew.platform import context as ctx_mod
from kiro_crew.platform import governance as gov
from kiro_crew.platform import governance_profiles as gp
from kiro_crew.platform.bootstrap import build_default_context
from kiro_crew.platform.governance import (
    CAPABILITY,
    REMOTE_EXEC_SCOPE,
    SCOPE_CATALOG,
    parse_policy,
    remote_exec_enabled,
)
from kiro_crew.subagent_manager import admission as adm


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    d = tmp_path / "profiles"
    d.mkdir()
    monkeypatch.setattr(gp, "_PROFILES_DIR", d)
    gp.reset_store()
    yield
    gp.reset_store()
    ctx_mod.reset_context()


def _install(policy_body) -> None:
    from kiro_crew.config.loader import KiroCrewConfig

    base = build_default_context(KiroCrewConfig.load())
    ceiling = parse_policy(policy_body) if policy_body is not None else None
    ctx_mod.set_context(dataclasses.replace(base, governance=ceiling))


def _policy(**capabilities) -> dict:
    return {
        "version": 1,
        "boot": {"fail_closed": True},
        "capabilities": capabilities,
    }


# ── the catalog row ──────────────────────────────────────────────────────────
class TestTheCatalogRow:
    def test_it_is_an_opt_in_capability(self) -> None:
        spec = SCOPE_CATALOG[REMOTE_EXEC_SCOPE]

        assert spec.kind == CAPABILITY
        assert spec.capability_default is False, "remote execution must never default on"
        # No inner ruleset, so no new matcher registry entry — the same shape
        # ``capabilities.agentcore`` has.
        assert spec.scope_matchers == {}
        assert spec.matcher in gov._MATCHERS

    def test_the_evaluator_never_learned_the_name(self) -> None:
        """Adding the scope is a DATA change. Asserted against the source, because
        a behavioural test cannot tell a generic dispatch from a branch that
        happens to agree with it today."""
        for fn in (gov.resolve, gov.gate_decision, gov._parse_controls):
            assert "remote_exec" not in inspect.getsource(fn), fn.__name__

    def test_omission_still_reads_as_ungoverned_at_the_evaluator(self) -> None:
        """The consumer's fail-closed reading must not have been bought by
        changing the evaluator's omission contract, which every other scope
        depends on (and whose ``layer == "default"`` is the operator's
        missing-control alarm)."""
        ceiling = parse_policy(_policy(script_hooks={"enabled": False}))
        decision = gov.resolve(ceiling, None, REMOTE_EXEC_SCOPE, "")

        assert decision.permitted
        assert decision.layer == "default"

    def test_the_positive_reader_answers_no_for_every_absent_shape(self) -> None:
        assert remote_exec_enabled(None) is False
        assert remote_exec_enabled(parse_policy(_policy())) is False
        assert remote_exec_enabled(parse_policy(_policy(remote_exec={}))) is False
        assert remote_exec_enabled(parse_policy(_policy(remote_exec={"enabled": False}))) is False

    def test_the_positive_reader_answers_yes_only_on_a_grant(self) -> None:
        assert remote_exec_enabled(parse_policy(_policy(remote_exec={"enabled": True}))) is True


# ── the vetting helper ───────────────────────────────────────────────────────
class TestTheVettingHelper:
    def test_a_local_spawn_is_not_this_gates_subject(self) -> None:
        _install(None)
        assert adm._vet_remote_exec_governance("cli_chat", adm.EXECUTOR_LOCAL) is None

    def test_an_unknown_executor_kind_is_refused(self) -> None:
        """Identity is positive membership. A kind nobody has reasoned about must
        not be admitted by failing to match anything."""
        _install(_policy(remote_exec={"enabled": True}))
        reason = adm._vet_remote_exec_governance("cli_chat", "some-future-runtime")

        assert reason is not None
        assert "unknown executor" in reason

    def test_an_ungoverned_host_refuses_a_remote_spawn(self) -> None:
        _install(None)
        reason = adm._vet_remote_exec_governance("cli_chat", adm.EXECUTOR_AGENTCORE)

        assert reason is not None
        assert REMOTE_EXEC_SCOPE in reason, "the refusal must name the scope to grant"

    def test_a_policy_that_omits_the_capability_refuses(self) -> None:
        _install(_policy(spawn={"enabled": True}))
        reason = adm._vet_remote_exec_governance("cli_chat", adm.EXECUTOR_AGENTCORE)

        assert reason is not None
        assert REMOTE_EXEC_SCOPE in reason

    def test_a_policy_that_disables_the_capability_refuses(self) -> None:
        _install(_policy(remote_exec={"enabled": False}))
        assert adm._vet_remote_exec_governance("cli_chat", adm.EXECUTOR_AGENTCORE) is not None

    def test_a_policy_that_grants_the_capability_permits(self) -> None:
        _install(_policy(remote_exec={"enabled": True}))
        assert adm._vet_remote_exec_governance("cli_chat", adm.EXECUTOR_AGENTCORE) is None

    def test_a_profile_can_take_the_grant_back(self, tmp_path) -> None:
        """POLICY ∩ PROFILE, tightest-wins: the positive read is the policy half,
        and ``governance_permits`` is what lets a per-surface profile narrow it."""
        _install(_policy(remote_exec={"enabled": True}))
        # The bind id is the surface the RESOLVER infers, taken from its own
        # classifier rather than spelled by hand — a hand-spelled id that no longer
        # matches the taxonomy would make this test pass vacuously.
        profile = {
            "name": "cli",
            "bind": {"type": "surface", "id": gp._infer_surface("cli_chat")},
            "capabilities": {"remote_exec": {"enabled": False}},
        }
        (gp._PROFILES_DIR / "cli.json").write_text(json.dumps(profile), encoding="utf-8")
        gp.reset_store()
        assert gp.resolve_active_scope("cli_chat") is not None, "the profile must bind"

        reason = adm._vet_remote_exec_governance("cli_chat", adm.EXECUTOR_AGENTCORE)
        assert reason is not None
        assert REMOTE_EXEC_SCOPE in reason, "every refusal names the row to grant"

    def test_an_evaluation_error_denies(self, monkeypatch) -> None:
        _install(_policy(remote_exec={"enabled": True}))

        def _boom(*_a, **_k):
            raise RuntimeError("evaluator exploded")

        monkeypatch.setattr(gp, "governance_permits", _boom)
        reason = adm._vet_remote_exec_governance("cli_chat", adm.EXECUTOR_AGENTCORE)

        assert reason is not None
        assert "fail-closed" in reason


# ── the spawn-admission chokepoint ───────────────────────────────────────────
def _mgr():
    from kiro_crew.subagent import SubagentManager

    return SubagentManager(
        sessions=MagicMock(),
        ctx_builder=MagicMock(),
        on_done=None,
        max_concurrent=3,
    )


class _Admitted:
    admitted = True
    reason = ""
    available_gb = 8.0
    posture = "ample"


def _spawn(manager, **kwargs):
    """Drive ``spawn_impl`` past the memory/admission guards deterministically.

    ``executor`` is keyword-only on ``spawn_impl`` and the facade's ``spawn`` does
    not forward it yet (WP4 owns that signature), so the coordinator is called
    directly — which is also the narrowest surface that proves the gate.
    """
    with (
        patch("kiro_crew.subagent.check_memory_available", return_value=(True, 8.0)),
        patch("kiro_crew.subagent.KiroCrewConfig") as cfg,
        patch("kiro_crew.subagent.cached_admission_check", return_value=_Admitted()),
        patch("kiro_crew.subagent.sel") as sel,
    ):
        cfg.load.return_value.agent.spawn_min_memory_gb = 4.0
        cfg.load.return_value.agent.subagent_cwd_allowed_roots = []
        sel.return_value.log_tool_invocation = MagicMock()
        info = manager._admission.spawn_impl("remote work", parent_session_key="cli_chat", **kwargs)
    return info, sel.return_value.log_tool_invocation


class TestSpawnAdmissionEnforcesIt:
    def test_a_remote_spawn_is_refused_when_the_policy_omits_the_capability(self) -> None:
        _install(_policy(spawn={"enabled": True}))
        manager = _mgr()

        info, _audit = _spawn(manager, executor=adm.EXECUTOR_AGENTCORE)

        assert info is not None
        assert info.done is True
        assert "refused by governance" in info.error
        assert REMOTE_EXEC_SCOPE in info.error, "the operator must learn what to grant"

    def test_the_refusal_is_not_a_silent_local_spawn(self) -> None:
        """The load-bearing half. A downgrade would answer "run this elsewhere" by
        running untrusted work on the operator's own machine."""
        _install(_policy())
        manager = _mgr()

        info, _audit = _spawn(manager, executor=adm.EXECUTOR_AGENTCORE)

        assert info is not None and info.error
        assert manager._agents == {}, "a refused remote spawn must register no run"
        assert manager._tasks == {}, "a refused remote spawn must start no local task"
        assert manager._running_count == 0
        assert manager._queue == []

    def test_the_refusal_is_audited(self) -> None:
        _install(_policy())
        manager = _mgr()

        _info, audit = _spawn(manager, executor=adm.EXECUTOR_AGENTCORE)

        rows = [
            call.kwargs
            for call in audit.call_args_list
            if call.kwargs.get("metadata", {}).get("scope") == REMOTE_EXEC_SCOPE
        ]
        assert rows, f"no SEL row named the scope: {audit.call_args_list}"
        row = rows[-1]
        assert row["outcome"] == "denied"
        assert row["tool_name"] == "spawn_run"
        assert row["session_key"] == "cli_chat"
        assert row["metadata"]["executor"] == adm.EXECUTOR_AGENTCORE
        assert REMOTE_EXEC_SCOPE in row["error"]

    def test_a_granted_remote_spawn_passes_the_gate(self) -> None:
        """It falls through to the next guard (no approval mechanism is configured
        on this manager), which is what proves the governance gate did not stop
        it — and does so without launching a subagent."""
        _install(_policy(remote_exec={"enabled": True}))
        manager = _mgr()

        info, audit = _spawn(manager, executor=adm.EXECUTOR_AGENTCORE)

        assert info is not None
        assert "governance" not in (info.error or "")
        assert info.error == "spawn rejected: no approval mechanism configured"
        assert not [
            call
            for call in audit.call_args_list
            if call.kwargs.get("metadata", {}).get("scope") == REMOTE_EXEC_SCOPE
        ]

    def test_a_local_spawn_is_unaffected_on_a_baseline_host(self) -> None:
        """WP2 is a public no-op: an ordinary spawn with no executor named reaches
        the same guard it always did, on a host with no policy at all."""
        _install(None)
        manager = _mgr()

        info, _audit = _spawn(manager)

        assert info is not None
        assert info.error == "spawn rejected: no approval mechanism configured"

    def test_a_remote_spawn_that_would_queue_is_refused_not_downgraded(self) -> None:
        """The queue round-trip re-enters through the facade, which carries no
        ``executor`` — so draining a queued remote member would run it locally.
        Refused instead, the way a prevalidated app spawn is."""
        _install(_policy(remote_exec={"enabled": True}))
        manager = _mgr()
        manager._running_count = manager._max_concurrent  # at capacity → queue

        info, _audit = _spawn(manager, executor=adm.EXECUTOR_AGENTCORE)

        assert info is not None
        assert info.done is True
        assert "not queued" in info.error
        assert manager._queue == [], "a remote member must not sit in the queue"
