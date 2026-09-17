"""WP4: the executor reaches a real caller, and the queue cannot drop it.

The load-bearing test here is :func:`test_a_queued_remote_spawn_drains_with_its_executor`.
WP2 REFUSED a remote spawn that would queue, and the refusal was not caution: the
stagger queue stores a spawn's arguments in a dict and re-enters through
``SubagentManager.spawn(**params)``, so an ``executor`` the facade's signature could not
express was an ``executor`` the drain silently dropped -- and dropping it means running a
remote delegation's untrusted repository code on the operator's own machine, with nothing
red to say so. Three parts now carry it: the facade's keyword-only parameter, the queue
dict's entry, and the drain's existing ``**params`` call. Remove any one and this test
fails, which is the only reason the refusal could go.

The surface tests are deliberately about REFUSAL and CARRIAGE rather than about a remote
turn actually running: a real remote session needs a deployed worker, and WP3's bridge is
tested against its own fake. What is asserted here is that a caller can ask, that an
unknown value is answered rather than degraded, and that the answer is the operator's
configuration rather than a local run.
"""

from __future__ import annotations

import inspect

from kiro_crew.subagent import SubagentManager
from kiro_crew.subagent_manager.admission import (
    EXECUTOR_AGENTCORE,
    EXECUTOR_LOCAL,
    REMOTE_EXECUTORS,
)


def test_the_facade_can_express_an_executor_at_all() -> None:
    """The signature IS the mechanism: a kwargs sink would drop it on the drain."""
    sig = inspect.signature(SubagentManager.spawn)
    assert "executor" in sig.parameters, (
        "the stagger queue re-enters through this facade with spawn(**params); an "
        "executor the signature cannot name is one the drain cannot carry"
    )
    param = sig.parameters["executor"]
    assert param.kind is inspect.Parameter.KEYWORD_ONLY, (
        "keyword-only so a positional caller cannot set it by accident, and so adding "
        "it could not reorder an existing call"
    )
    assert param.default == EXECUTOR_LOCAL


def test_continue_conversation_takes_no_executor() -> None:
    """A remote session is single-turn, so a finished one cannot be resumed in place.

    Offering an executor here would suggest it could, and the honest follow-up is a new
    spawn seeded with a summary.
    """
    sig = inspect.signature(SubagentManager.continue_conversation)
    assert "executor" not in sig.parameters


def test_the_queue_dict_carries_the_executor() -> None:
    """Read off the source, because the drain reads this dict and nothing else.

    A behavioural test would need a queue at capacity plus a timer callback; this asserts
    the same invariant at the point where omitting a key is the whole defect.
    """
    source = _admission_source()
    queue_block = source.split("self._manager._queue.append(")[1].split("\n        )")[0]
    assert '"executor": executor' in queue_block, (
        "the queued params dict is the drain's ONLY input; a missing entry here is a "
        "silent downgrade to a local run"
    )


def _admission_source() -> str:
    from pathlib import Path

    from kiro_crew.subagent_manager import admission

    return Path(inspect.getfile(admission)).read_text(encoding="utf-8")


def test_the_refusal_that_stood_in_for_carriage_is_gone() -> None:
    """WP2's refusal was explicitly temporary, and leaving it would now be a lie."""
    source = _admission_source()
    assert "remote spawn would queue" not in source
    assert "the queue round-trip cannot carry the executor" not in source


def test_the_executor_vocabulary_is_closed_and_local_is_the_default() -> None:
    assert EXECUTOR_LOCAL == ""
    assert EXECUTOR_AGENTCORE == "agentcore"
    assert REMOTE_EXECUTORS == frozenset({EXECUTOR_AGENTCORE})
    assert EXECUTOR_LOCAL not in REMOTE_EXECUTORS, (
        "the default must not be a remote executor, or an unconfigured spawn would ask "
        "for a container"
    )


def test_the_spawn_tool_offers_the_executor_and_says_what_it_costs() -> None:
    """An LLM-facing argument whose description omits the cost gets used for speed."""
    from kiro_crew.mcp_tools import spawn as spawn_tool

    tools = {entry["name"]: entry for entry in spawn_tool.schemas()}
    props = tools["spawn_run"]["inputSchema"]["properties"]
    assert "executor" in props, "spawn_run must expose it; the MCP surface is mandatory"
    description = props["executor"]["description"]
    assert "agentcore" in description
    for expected in ("SINGLE-TURN", "capabilities.remote_exec", "own AWS account"):
        assert expected in description, f"the description must state {expected!r}"


def test_the_cli_twin_forwards_the_executor_it_was_given() -> None:
    """The twin's contract is the request body, so assert on the body it sends."""
    import argparse
    import json

    from kiro_crew import cli_commands

    captured: dict[str, object] = {}

    class _Resp:
        def __enter__(self) -> "_Resp":
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps({"id": "abc123", "task": "do a thing"}).encode()

    def _fake_open(req: object, timeout: int = 5) -> _Resp:
        captured["body"] = json.loads(getattr(req, "data", b"{}").decode())
        return _Resp()

    original_open = cli_commands.loopback_urlopen
    original_secret = cli_commands._internal_secret
    cli_commands.loopback_urlopen = _fake_open  # type: ignore[assignment]
    cli_commands._internal_secret = lambda _port: "secret"  # type: ignore[assignment]
    try:
        args = argparse.Namespace(
            task="do a thing", fire_and_forget=True, port=5476, executor="agentcore"
        )
        cli_commands._spawn_run(args, "http://127.0.0.1:5476")
        assert captured["body"] == {"task": "do a thing", "executor": "agentcore"}

        captured.clear()
        local = argparse.Namespace(task="do a thing", fire_and_forget=True, port=5476, executor="")
        cli_commands._spawn_run(local, "http://127.0.0.1:5476")
        assert captured["body"] == {
            "task": "do a thing"
        }, "a local spawn's request must stay byte-identical to what it always was"
    finally:
        cli_commands.loopback_urlopen = original_open  # type: ignore[assignment]
        cli_commands._internal_secret = original_secret  # type: ignore[assignment]


def test_the_cli_declares_the_flag() -> None:
    """The parser is built inside main(), so the declaration is checked at its source."""
    from pathlib import Path

    from kiro_crew import cli

    source = Path(inspect.getfile(cli)).read_text(encoding="utf-8")
    spawn_block = source.split('spawn_sub.add_parser("run"')[1].split("spawn_sub.add_parser")[0]
    assert '"--executor"' in spawn_block


# ── the bridge's lifecycle on the provider ──


class _FakeBridge:
    """Stands in for AgentCoreBridge: records the calls the provider must make."""

    def __init__(self) -> None:
        self.spawn_env = {"KIROCREW_AGENTCORE_SOCKET": "/tmp/x.sock", "OWNER": "t"}
        self.runs: list[dict] = []
        self.stops = 0

    async def run(self, start_body: dict) -> None:
        self.runs.append(start_body)
        import asyncio

        await asyncio.sleep(3600)  # a live session: only teardown ends it

    async def stop(self) -> None:
        self.stops += 1


def _provider_with(bridge: object) -> object:
    from kiro_crew.providers.acp import AcpProvider

    return AcpProvider(acp_backend="agentcore", remote_bridge=bridge)


def test_a_local_provider_has_no_bridge_and_teardown_is_a_no_op() -> None:
    """The whole local path must be untouched: no bridge, no task, no new failure."""
    import asyncio

    from kiro_crew.providers.acp import AcpProvider

    provider = AcpProvider(acp_backend="")
    assert provider._remote_bridge is None
    assert provider._remote_task is None
    asyncio.run(provider._start_remote_bridge())
    asyncio.run(provider._stop_remote_bridge())


def test_the_bridge_starts_once_and_stops_on_teardown() -> None:
    """A second start must not open a second socket: the relay accepts exactly one."""
    import asyncio

    bridge = _FakeBridge()
    provider = _provider_with(bridge)

    async def exercise() -> None:
        await provider._start_remote_bridge()  # type: ignore[attr-defined]
        await provider._start_remote_bridge()  # type: ignore[attr-defined]
        # create_task only SCHEDULES: yield once so the bridge's coroutine actually
        # reaches its first line, or this asserts on a task that has not run.
        await asyncio.sleep(0)
        assert len(bridge.runs) == 1, "a resume or model swap must not re-dial"
        assert provider._remote_task is not None  # type: ignore[attr-defined]
        await provider._stop_remote_bridge()  # type: ignore[attr-defined]
        assert bridge.stops == 1
        assert provider._remote_task is None  # type: ignore[attr-defined]
        assert provider._remote_bridge is None  # type: ignore[attr-defined]

    asyncio.run(exercise())


def test_a_bridge_whose_stop_raises_does_not_break_teardown() -> None:
    """Teardown runs on the error path too; a raising stop would mask the real cause."""
    import asyncio

    class _Angry(_FakeBridge):
        async def stop(self) -> None:
            raise RuntimeError("worker unreachable")

    provider = _provider_with(_Angry())

    async def exercise() -> None:
        await provider._start_remote_bridge()  # type: ignore[attr-defined]
        await provider._stop_remote_bridge()  # type: ignore[attr-defined]
        assert provider._remote_task is None  # type: ignore[attr-defined]

    asyncio.run(exercise())
