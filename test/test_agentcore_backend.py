"""The agentcore backend: does it resolve through the ONE gate, and stay inert absent?

WP2. Four questions, and the last one is the one Spike B found the hard way.

* The registered id resolves through the single existing selection gate, once the
  edition has registered it. It is NOT baseline-selectable, so the registration call
  is part of the test rather than a fixture detail — that asymmetry IS the design.
* A session that asked for nothing still resolves the Kiro default, unchanged.
* The tool gate does not refuse a call on the new id.
* An executor forces the DEDICATED arm explicitly. Relying on
  ``is_session_sharing_eligible`` alone means an executor passed to a
  sharing-eligible spawn is silently ignored — a wrong answer rather than an error.

What "the real call path" means here, because a test that overstates its evidence is
worse than none: the gate assertions drive the REAL
``KiroCrewConfig.create_provider_factory()`` closure, the REAL
``members.select_provider_backend`` and the REAL ``resolve_selected_backend``, and
they read the backend off the REAL ``AcpProvider`` that was constructed. Nothing is
stubbed and no process starts — ``AcpProvider.__init__`` validates and stores while
``start()`` spawns, and ``start()`` is never called.
"""

from __future__ import annotations

import inspect

import pytest

from kiro_crew.acp.harness import AgentCoreHarness, harness_for
from kiro_crew.acp_backends import (
    ACP_BACKEND_AGENTCORE,
    ACP_BACKEND_KIRO,
    ACP_BACKEND_ROUTING,
    ACP_BACKENDS_KNOWN,
    ACP_BACKENDS_SESSION_SHARING,
    BASELINE_SELECTABLE_BACKENDS,
    resolve_selected_backend,
    selectable_backends,
)
from kiro_crew.agent_sdk import backends as sdk_backends
from kiro_crew.agent_sdk import tool_gate
from kiro_crew.config import KiroCrewConfig
from kiro_crew.members import select_provider_backend
from kiro_crew.session_allocation import SessionAllocationService
from kiro_crew.subagent import SubagentInfo


def _backend_of(provider: object) -> str:
    """The backend the provider was actually constructed with."""
    return str(getattr(getattr(provider, "client", None), "backend", "<none>"))


@pytest.fixture
def registered():
    """The id registered the way an edition registers it, then restored.

    BOTH module-global sets are snapshotted, because ``register_selectable_backend``
    writes both: restoring only ``_selectable`` leaks a widened baseline into every
    later test in the run.
    """
    baseline_before = set(sdk_backends._baseline)
    selectable_before = set(sdk_backends._selectable)
    sdk_backends.register_selectable_backend(ACP_BACKEND_AGENTCORE)
    yield
    sdk_backends._baseline.clear()
    sdk_backends._baseline.update(baseline_before)
    sdk_backends._selectable.clear()
    sdk_backends._selectable.update(selectable_before)


# ── Registration: spellable, and deliberately not selectable ──


def test_the_id_is_known_but_not_baseline_selectable() -> None:
    """Spellable and unreachable, which is what a public no-op looks like.

    The two halves are separate claims. Membership in ``ACP_BACKENDS_KNOWN`` is what
    lets ``AcpProvider`` accept the value and the harness table resolve it; absence
    from the baseline is what keeps the dashboard switch from offering a harness whose
    every session would stall at the handshake with no bridge listening.
    """
    assert ACP_BACKEND_AGENTCORE in ACP_BACKENDS_KNOWN
    assert ACP_BACKEND_AGENTCORE not in BASELINE_SELECTABLE_BACKENDS
    assert ACP_BACKEND_AGENTCORE not in selectable_backends()


def test_an_unregistered_id_degrades_rather_than_reaching_construction() -> None:
    """H3 on a plain build: asking for it without the extra gets Kiro and a log.

    Not a bug being pinned — this is the whole default-off claim. The value never
    propagates to ``AcpProvider``, which would raise on it.
    """
    assert resolve_selected_backend(ACP_BACKEND_AGENTCORE) == ACP_BACKEND_KIRO


def test_registering_it_makes_the_one_gate_resolve_it(registered) -> None:
    """The edition seam, and the ONLY seam: ``register_selectable_backend``."""
    assert ACP_BACKEND_AGENTCORE in selectable_backends()
    assert resolve_selected_backend(ACP_BACKEND_AGENTCORE) == ACP_BACKEND_AGENTCORE


def test_the_routing_member_is_agent_spec() -> None:
    """AGENT_SPEC, positively, and pinned because the alternative costs real controls.

    Every non-AGENT_SPEC member obliges a credential mask on the spawn plan and a
    sandbox-tier consult, and the two ENFORCED members additionally oblige a
    credential leaf plus a preflight arm inside ``AcpClient._spawn`` — all of it
    asserted about a local process that is a byte relay. Read positively off the
    table rather than as "not enforced".
    """
    assert ACP_BACKEND_ROUTING[ACP_BACKEND_AGENTCORE] is tool_gate.Routing.AGENT_SPEC


# ── The one gate, driven for real ──


def test_the_factory_gate_resolves_the_executor_override(registered, tmp_path) -> None:
    """An executor passed to the provider factory selects the remote backend."""
    factory = KiroCrewConfig().create_provider_factory()
    provider = factory("wp2:override", cwd=str(tmp_path), executor=ACP_BACKEND_AGENTCORE)
    assert _backend_of(provider) == ACP_BACKEND_AGENTCORE


def test_a_session_with_no_executor_still_resolves_the_kiro_default(registered, tmp_path) -> None:
    """The control, and the assertion H1/H13 turn on.

    Registered in this test too, on purpose: the default must be unchanged even on a
    build where the remote id IS selectable, or the feature has been bought by taxing
    every local session.
    """
    factory = KiroCrewConfig().create_provider_factory()
    provider = factory("wp2:control", cwd=str(tmp_path))
    assert _backend_of(provider) == ACP_BACKEND_KIRO


@pytest.mark.parametrize("bogus", ["not-a-backend", "AGENTCORE", "agentcore ", 17, None])
def test_an_unselectable_executor_degrades_to_kiro(tmp_path, bogus) -> None:
    """H3 through the new arm: the override crosses the SAME coercion.

    ``None`` is in the list deliberately: it is the absent case, and it must take the
    fall-through rather than the override arm.
    """
    factory = KiroCrewConfig().create_provider_factory()
    provider = factory("wp2:bogus", cwd=str(tmp_path), executor=bogus)
    assert _backend_of(provider) == ACP_BACKEND_KIRO


def test_the_gate_is_reached_exactly_once(registered, monkeypatch, tmp_path) -> None:
    """H4/H13: ONE selection call on the per-session path, not two.

    A second gate — an executor-specific coercion beside the existing one — shows up
    here as a count of two. Patched on ``kiro_crew.acp_backends``, the re-export shim,
    because that is the name ``select_provider_backend`` resolves: it imports inside
    the function body, so a per-call patch there is seen.

    Scope stated honestly: this counts the PER-SESSION crossing only. The
    persisted-field crossing in ``config.sections`` binds the same function at module
    import and is invisible to this patch — which is what makes the count meaningful,
    since the two answer different questions (what was persisted, versus what this
    session asked for) and both always existed.
    """
    import kiro_crew.acp_backends as shim

    calls: list[object] = []
    real = shim.resolve_selected_backend

    def counting(value: object) -> str:
        calls.append(value)
        return real(value)

    monkeypatch.setattr(shim, "resolve_selected_backend", counting)

    factory = KiroCrewConfig().create_provider_factory()
    provider = factory("wp2:count", cwd=str(tmp_path), executor=ACP_BACKEND_AGENTCORE)

    assert _backend_of(provider) == ACP_BACKEND_AGENTCORE
    assert calls == [ACP_BACKEND_AGENTCORE], f"expected ONE gate crossing, got {calls!r}"


def test_the_executor_arm_outranks_the_member_route(registered) -> None:
    """Precedence on the gate's own per-session half.

    An explicit executor is a caller's stated intent; the member-DM auto-route is an
    inference. The explicit one wins, and with no executor the member arm is untouched.
    """
    assert (
        select_provider_backend(
            "member:U123",
            ACP_BACKEND_KIRO,
            ACP_BACKEND_KIRO,
            ACP_BACKEND_AGENTCORE,
        )
        == ACP_BACKEND_AGENTCORE
    )
    assert (
        select_provider_backend("member:U123", ACP_BACKEND_KIRO, ACP_BACKEND_KIRO)
        == ACP_BACKEND_KIRO
    )


# ── The tool gate does not refuse a call on the new id ──


def test_the_tool_gate_does_not_refuse_this_host() -> None:
    """A registered id the gate refuses looks like a broken agent, not a config error.

    ``AGENT_SPEC`` is outside ``ENFORCED_ROUTINGS``, so the verdict is ROUTED and no
    refusal follows. Read through the gate's own entry point rather than by re-reading
    the routing table: the table is an INPUT to this answer, and the answer is what a
    session actually experiences.
    """
    verdict, why = tool_gate.routing_verdict(ACP_BACKEND_AGENTCORE)
    assert verdict is tool_gate.Verdict.ROUTED, why
    assert tool_gate.is_enforced(ACP_BACKEND_AGENTCORE) is False
    # An unenforced host offers no remediation, because nothing is wrong to fix.
    assert tool_gate.remediation_for(ACP_BACKEND_AGENTCORE) == ""


def test_an_agent_spec_host_claims_no_credential_mask() -> None:
    """The corollary of AGENT_SPEC: no mask, and so nothing to re-expose.

    The mask compensates for privileged tools that do not ask. This host's do ask (the
    remote child is ``kiro-cli --agent <name>``) and the LOCAL process is a byte relay
    with nothing to fence, so claiming one would assert a control that never runs and a
    threat model this host does not have.
    """
    hidden = tool_gate.adapter_hidden_credential_dirs(ACP_BACKEND_AGENTCORE)
    assert hidden == ()
    assert tool_gate.adapter_expose_files(ACP_BACKEND_AGENTCORE, hidden) == ()


# ── The carrier, and the forced arm ──


def test_the_run_path_carries_the_executor_on_the_existing_pass_through() -> None:
    """``SubagentInfo.executor`` reaches the factory as a kwarg, unmodified.

    Asserted structurally: the channel is three signatures deep and each one is an
    opaque ``**kwargs`` forward, so what has to be true is that none of them drops an
    unrecognized key.
    """
    info = SubagentInfo(id="wp2", task="t", executor=ACP_BACKEND_AGENTCORE)
    assert info.executor == ACP_BACKEND_AGENTCORE

    sig = inspect.signature(SessionAllocationService.get_or_create)
    assert any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
    ), "get_or_create must forward unrecognized kwargs for the carrier to exist"

    factory = KiroCrewConfig().create_provider_factory()
    assert "executor" in inspect.signature(factory).parameters


def test_an_executor_forces_the_dedicated_arm_explicitly() -> None:
    """The arm is FORCED, not merely arrived at — the finding this test exists for.

    Two things already push a remote session onto the dedicated arm:
    ``is_session_sharing_eligible`` is false for it (the id is outside
    ``ACP_BACKENDS_SESSION_SHARING``), and the shared-runtime branch type-checks for
    the local ACP provider. Both are true and NEITHER is sufficient, because
    ``use_session_sharing`` is computed from the SPAWN's eligibility before any harness
    exists: an executor passed to a sharing-eligible spawn would be carried in
    ``extra_kwargs`` to a factory the shared arm never calls, and the run would come up
    on the PARENT's harness with nothing red to say so. A wrong answer, not an error —
    which is why the branch is pinned on the source rather than inferred from the set.
    """
    from kiro_crew.subagent_manager import run as run_mod

    assert ACP_BACKEND_AGENTCORE not in ACP_BACKENDS_SESSION_SHARING
    source = inspect.getsource(run_mod)
    assert "if info.executor:\n            use_session_sharing = False" in source, (
        "the dedicated arm must be forced for a non-empty executor; without this "
        "branch an executor on a sharing-eligible spawn is SILENTLY IGNORED"
    )


def test_the_pass_through_reaches_a_recording_factory() -> None:
    """The kwarg survives the forward, observed rather than inferred."""
    seen: dict[str, object] = {}

    def recording_factory(session_key: str | None = None, **kwargs: object) -> object:
        seen.update(kwargs)
        return object()

    info = SubagentInfo(id="wp2", task="t", executor=ACP_BACKEND_AGENTCORE)
    extra_kwargs: dict[str, object] = {}
    if info.executor:
        extra_kwargs["executor"] = info.executor

    recording_factory("subagent:wp2", agent=None, **extra_kwargs)
    assert seen["executor"] == ACP_BACKEND_AGENTCORE


# ── The harness ──


def test_the_harness_table_serves_the_id() -> None:
    harness = harness_for(ACP_BACKEND_AGENTCORE)
    assert isinstance(harness, AgentCoreHarness)
    assert harness.backend == ACP_BACKEND_AGENTCORE


@pytest.mark.asyncio
async def test_the_spawn_argv_is_the_stdio_shim(tmp_path) -> None:
    """The argv launches the shim, carrying the socket the BRIDGE published.

    The socket path is read off the spawn's environment snapshot rather than derived:
    two processes agreeing on a derived path agree by coincidence, and the bridge is
    the one that binds nothing and dials in.
    """
    import sys

    from kiro_crew.acp.harness.base import SpawnContext
    from kiro_crew.agentcore.stdio_shim import OWNER_TOKEN_ENV

    sock = str(tmp_path / "s.sock")
    ctx = SpawnContext(
        agent="a",
        work_dir=str(tmp_path),
        model=None,
        environ={"KIROCREW_AGENTCORE_SOCKET": sock, OWNER_TOKEN_ENV: "tok"},
        home=tmp_path,
    )
    plan = await harness_for(ACP_BACKEND_AGENTCORE).resolve_spawn(ctx)

    assert plan.argv == [sys.executable, "-m", "kiro_crew.agentcore.stdio_shim", "--socket", sock]
    # The token is NOT on the argv: an argv is visible in ``ps`` to every process of
    # every user on the machine.
    assert "tok" not in " ".join(plan.argv)
    # AGENT_SPEC, so no mask and no host-auth arm.
    assert plan.extra_hidden_dirs == ()
    assert plan.host_auth is False
