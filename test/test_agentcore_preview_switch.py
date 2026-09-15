"""The remote-executor preview switch: what makes ``agentcore`` selectable, and what
deliberately does not.

The narrowing on ``BASELINE_SELECTABLE_BACKENDS`` objects to ONE state -- a dashboard
switch whose every session stalls with nothing behind the shim's socket. These tests are
about that objection surviving the on-ramp, so most of them assert a REFUSAL: intent
without a runtime, a runtime without intent, and a broken runtime file all leave the id
unselectable, and a governance deny still removes it after registration.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterator

import pytest

from kiro_crew.agent_sdk import backends as acp_backends
from kiro_crew.platform import defaults


@pytest.fixture
def restore_registry() -> Iterator[None]:
    """Snapshot BOTH module-global sets around a mutation.

    Both, because ``register_selectable_backend`` writes both: restoring only the
    effective set would leak a widened baseline into every later test in the run.
    """
    baseline = set(acp_backends._baseline)
    selectable = set(acp_backends._selectable)
    try:
        yield
    finally:
        acp_backends._baseline.clear()
        acp_backends._baseline.update(baseline)
        acp_backends._selectable.clear()
        acp_backends._selectable.update(selectable)


@pytest.fixture
def runtime_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make a runtime observable without needing boto3 or an AWS account."""
    import kiro_crew.agentcore.bridge as bridge

    monkeypatch.setattr(
        bridge,
        "load_runtime_coordinates",
        lambda: bridge.RuntimeCoordinates(runtime_arn="arn:aws:x", region="us-east-1"),
    )


def test_a_plain_build_does_not_offer_the_remote_executor() -> None:
    """The default, and the one an operator who never opted in must keep getting."""
    assert acp_backends.ACP_BACKEND_AGENTCORE not in acp_backends.BASELINE_SELECTABLE_BACKENDS
    assert not acp_backends.agentcore_preview_requested()
    assert not defaults.agentcore_selectable_here()


@pytest.mark.parametrize("value", ["0", "false", "no", "off", ""])
def test_an_operator_keeping_a_paid_executor_off_is_not_handed_it(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """A bare ``bool()`` would read ``"0"`` as on. This bills a microVM -- it must not."""
    monkeypatch.setenv(acp_backends.ENV_AGENTCORE_PREVIEW, value)
    assert not acp_backends.agentcore_preview_requested()


def test_intent_alone_does_not_make_it_selectable(monkeypatch: pytest.MonkeyPatch) -> None:
    """The whole point of pairing the gates.

    Asking for a harness cannot conjure the runtime that answers for it, and a switch
    offered without one is exactly the stalling session the narrowing forbids.

    The absent runtime is spelled as the RAISE the loader actually performs, not as a
    ``None`` return: it fails closed and has no sentinel, so a test that stubbed one
    would prove a branch reality never takes.
    """
    monkeypatch.setenv(acp_backends.ENV_AGENTCORE_PREVIEW, "1")
    import kiro_crew.agentcore.bridge as bridge

    def _unconfigured() -> None:
        raise bridge.BridgeUnconfigured("no remote runtime is configured")

    monkeypatch.setattr(bridge, "load_runtime_coordinates", _unconfigured)

    assert acp_backends.agentcore_preview_requested(), "intent is there"
    assert not defaults.agentcore_selectable_here(), "but a runtime is not"


def test_the_loader_really_raises_rather_than_returning_a_sentinel() -> None:
    """Pins the contract the probe above depends on.

    If the loader ever started returning ``None`` for an absent runtime, the probe's
    ``except`` would stop being the path that catches it and this file's stubs would
    quietly diverge from production behaviour.
    """
    import inspect

    import kiro_crew.agentcore.bridge as bridge

    source = inspect.getsource(bridge.load_runtime_coordinates)
    assert "raise BridgeUnconfigured" in source
    assert "return None" not in source


def test_a_runtime_alone_does_not_make_it_selectable(
    monkeypatch: pytest.MonkeyPatch, runtime_configured: None
) -> None:
    """An operator who deployed a runtime has still not asked to route sessions to it."""
    monkeypatch.delenv(acp_backends.ENV_AGENTCORE_PREVIEW, raising=False)
    assert not defaults.agentcore_selectable_here()


def test_a_broken_runtime_file_fails_closed(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """An install whose coordinates do not parse IS the stalling switch.

    So the refusal is the answer rather than a fallback -- and it says so in the log,
    because an operator who set the flag and sees no option needs to know why.
    """
    monkeypatch.setenv(acp_backends.ENV_AGENTCORE_PREVIEW, "1")
    import kiro_crew.agentcore.bridge as bridge

    def _raise() -> None:
        raise ValueError("runtime file is malformed")

    monkeypatch.setattr(bridge, "load_runtime_coordinates", _raise)

    with caplog.at_level(logging.INFO):
        assert not defaults.agentcore_selectable_here()
    assert "no usable runtime" in caplog.text


def test_both_gates_together_make_it_selectable(
    monkeypatch: pytest.MonkeyPatch, runtime_configured: None, restore_registry: None
) -> None:
    """The on-ramp itself: the registry seam is no longer inert on a public build."""
    monkeypatch.setenv(acp_backends.ENV_AGENTCORE_PREVIEW, "1")
    assert defaults.agentcore_selectable_here()

    defaults.DefaultProviderRegistry().register_acp_backends()
    assert acp_backends.ACP_BACKEND_AGENTCORE in acp_backends.selectable_backends()


def test_registering_it_leaves_the_shipped_baseline_constant_alone(
    monkeypatch: pytest.MonkeyPatch, runtime_configured: None, restore_registry: None
) -> None:
    """The frozen constant is the statement about a PLAIN build and must not move.

    ``test_agent_backend_editable`` pins it against ``NOT_SHIPPED_SELECTABLE``, and an
    on-ramp that widened the constant would silently retire that pin instead of
    satisfying it.
    """
    monkeypatch.setenv(acp_backends.ENV_AGENTCORE_PREVIEW, "1")
    before = frozenset(acp_backends.BASELINE_SELECTABLE_BACKENDS)

    defaults.DefaultProviderRegistry().register_acp_backends()

    assert acp_backends.BASELINE_SELECTABLE_BACKENDS == before
    assert acp_backends.ACP_BACKEND_AGENTCORE not in before


def test_a_governance_deny_still_wins_after_the_switch_registered_it(
    monkeypatch: pytest.MonkeyPatch, runtime_configured: None, restore_registry: None
) -> None:
    """The ordering that makes the switch safe to ship.

    Bootstrap registers and THEN narrows, so an env var an operator sets cannot outrank
    the enterprise ceiling. Asserted here rather than trusted from that call order,
    because the whole security argument for the on-ramp rests on it.
    """
    monkeypatch.setenv(acp_backends.ENV_AGENTCORE_PREVIEW, "1")
    defaults.DefaultProviderRegistry().register_acp_backends()
    assert acp_backends.ACP_BACKEND_AGENTCORE in acp_backends.selectable_backends()

    removed = acp_backends.apply_selectable_denials({acp_backends.ACP_BACKEND_AGENTCORE})

    assert acp_backends.ACP_BACKEND_AGENTCORE in removed
    assert acp_backends.ACP_BACKEND_AGENTCORE not in acp_backends.selectable_backends()


def test_the_switch_cannot_be_aimed_at_another_harness() -> None:
    """It reads one env name and returns a bool, so there is nothing to aim.

    Pinned because the alternative shape -- a generic 'extra selectable backends' env
    list -- would let an operator turn on any known harness, including one whose
    preconditions nobody checked.
    """
    source = Path(acp_backends.__file__).read_text(encoding="utf-8")
    marker = "def agentcore_preview_requested"
    body = source[source.index(marker) : source.index(marker) + 900]
    assert "return env_flag_enabled(ENV_AGENTCORE_PREVIEW)" in body
    assert "ACP_BACKEND_" not in body.split('"""')[-1], "no backend id is read from env"
