"""The bridge, driven end to end against the fake worker and a stand-in relay.

No AWS, no container, no network beyond loopback. Two doubles stand in for the two real
ends, and each is a double for a stated reason rather than for convenience:

* :class:`HttpTransport` speaks the worker's HTTP contract to
  ``test/agentcore/fake_worker.py``, which is a faithful fake of
  ``packaging/agentcore-worker/server.mjs`` -- including the answers a bridge written
  against the RFC would get wrong (``actionResult`` rather than ``{ok, deliveredAtSeq}``,
  409 on a failed delivery, 409 on a second ``start``).
* :class:`FakeShim` binds and listens exactly as ``stdio_shim.serve_one_connection``
  does, because the bridge DIALS -- so a test that connected to the bridge would be
  testing the opposite of the real arrangement. It reads the owner-token line first and
  then exchanges newline-framed JSON, which is all the real relay does with the bytes.

What is deliberately NOT faked: the sequence watermark, the resume loop, the dedup guard
and the stop ladder are the code under test, so every assertion here is about the real
implementation's behaviour against a worker that behaves like the built one.
"""

from __future__ import annotations

import asyncio
import contextlib
import http.client
import json
import subprocess
import sys
import shutil
import tempfile
import textwrap
from collections.abc import Iterator
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from agentcore.fake_worker import FakeWorker, fake_worker
from kiro_crew.acp.liveness import VERDICT_DEAD, VERDICT_UNKNOWN, VERDICT_WORKING
from kiro_crew.agentcore.bridge import (
    ActionResult,
    AgentCoreBridge,
    BridgeUnconfigured,
    RuntimeCoordinates,
    load_runtime_coordinates,
    mint_owner_token,
    mint_session_id,
    socket_path_for,
)
from kiro_crew.agentcore.liveness import RemoteLiveness

# ── the two doubles ──


class HttpTransport:
    """The worker's HTTP contract, one method per answer shape."""

    def __init__(self, base_url: str) -> None:
        host, _, port = base_url.removeprefix("http://").partition(":")
        self._host = host
        self._port = int(port)
        self.stopped_sessions: list[str] = []
        self.stream_statuses: list[int] = []
        self.json_statuses: list[int] = []

    def _connect(self) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self._host, self._port, timeout=10)

    async def invoke_stream(self, body: dict[str, Any]) -> AsyncIterator[bytes]:
        conn = self._connect()
        await asyncio.to_thread(
            conn.request,
            "POST",
            "/invocations",
            json.dumps(body),
            {"Content-Type": "application/json"},
        )
        response = await asyncio.to_thread(conn.getresponse)
        self.stream_statuses.append(response.status)
        try:
            if response.status != 200:
                await asyncio.to_thread(response.read)
                return
            while True:
                chunk = await asyncio.to_thread(response.read1, 4096)
                if not chunk:
                    return
                yield chunk
        finally:
            conn.close()

    async def invoke_json(self, body: dict[str, Any]) -> tuple[int, object]:
        conn = self._connect()
        try:
            await asyncio.to_thread(
                conn.request,
                "POST",
                "/invocations",
                json.dumps(body),
                {"Content-Type": "application/json"},
            )
            response = await asyncio.to_thread(conn.getresponse)
            raw = await asyncio.to_thread(response.read)
            self.json_statuses.append(response.status)
            try:
                return response.status, json.loads(raw.decode("utf-8") or "null")
            except ValueError:
                return response.status, None
        finally:
            conn.close()

    async def stop_session(self, session_id: str) -> None:
        self.stopped_sessions.append(session_id)


class FakeShim:
    """Binds and listens like the real relay, then exchanges newline-framed JSON."""

    def __init__(self, socket_path: Path, owner_token: str) -> None:
        self._path = socket_path
        self._token = owner_token
        self._server: asyncio.AbstractServer | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self.connected = asyncio.Event()
        self.token_ok: bool | None = None
        self.received: list[dict[str, Any]] = []

    async def __aenter__(self) -> "FakeShim":
        self._server = await asyncio.start_unix_server(self._serve, path=str(self._path))
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._writer is not None:
            self._writer.close()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        presented = (await reader.readline()).decode("utf-8").rstrip("\n")
        self.token_ok = presented == self._token
        self._reader, self._writer = reader, writer
        self.connected.set()

    async def to_agent(self, timeout: float = 5.0) -> dict[str, Any]:
        """One message the BRIDGE wrote toward the agent."""
        await asyncio.wait_for(self.connected.wait(), timeout)
        assert self._reader is not None
        line = await asyncio.wait_for(self._reader.readline(), timeout)
        message = json.loads(line.decode("utf-8"))
        self.received.append(message)
        return message

    async def from_agent(self, message: dict[str, Any], timeout: float = 5.0) -> None:
        """Send a message as if the agent had written it to the relay's stdin."""
        await asyncio.wait_for(self.connected.wait(), timeout)
        assert self._writer is not None
        self._writer.write((json.dumps(message) + "\n").encode("utf-8"))
        await self._writer.drain()


@pytest.fixture()
def socket_root() -> Iterator[Path]:
    """A socket directory short enough for AF_UNIX.

    Not ``tmp_path``: pytest's basetemp lives under ``TMPDIR``, which on this project is a
    per-session scratch directory whose path alone is longer than the 104-byte
    ``sun_path`` limit -- so a socket bound under it fails with ``AF_UNIX path too long``
    before any of this module's behaviour is reached. The directory is removed on the way
    out, sockets included.
    """
    root = Path(tempfile.mkdtemp(prefix="kcb-", dir="/tmp"))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _bridge(
    worker: FakeWorker, socket_root: Path, **kwargs: Any
) -> tuple[AgentCoreBridge, FakeShim, HttpTransport]:
    session_id = mint_session_id()
    token = mint_owner_token()
    path = socket_path_for(session_id, root=socket_root)
    transport = HttpTransport(worker.base_url)
    bridge = AgentCoreBridge(
        transport,
        session_id=session_id,
        owner_token=token,
        socket_path=path,
        poll_interval_ms=kwargs.pop("poll_interval_ms", 40),
        dial_timeout_secs=kwargs.pop("dial_timeout_secs", 5.0),
        **kwargs,
    )
    return bridge, FakeShim(path, token), transport


def _text_update() -> dict[str, Any]:
    return {
        "type": "acp",
        "payload": {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"update": {"sessionUpdate": "agent_message_chunk"}},
        },
    }


def _end_turn(request_id: int = 3) -> dict[str, Any]:
    return {
        "type": "acp",
        "payload": {"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}},
    }


# ── a whole turn ──


@pytest.mark.asyncio
async def test_a_full_turn_reaches_the_relay_and_ends_with_done(socket_root: Path) -> None:
    """Every acp payload is written into the socket, in order, and done is terminal."""
    with fake_worker() as worker:
        worker.script([_text_update(), _end_turn()])
        bridge, shim, _transport = _bridge(worker, socket_root)
        async with shim:
            run = asyncio.ensure_future(bridge.run({"prompt": "hello", "cwd": "/repo"}))
            first = await shim.to_agent()
            second = await shim.to_agent()
            outcome = await asyncio.wait_for(run, 10)

    assert shim.token_ok is True, "the relay must see the exact owner token the bridge minted"
    assert first["method"] == "session/update"
    assert second["result"]["stopReason"] == "end_turn"
    assert outcome.stop_reason == "end_turn"
    assert outcome.ok is True
    assert outcome.duplicates_suppressed == 0
    assert outcome.last_seq >= 2


# ── the one resume path ──


@pytest.mark.asyncio
async def test_a_drop_is_resumed_by_attach_with_no_loss_and_no_duplication(
    socket_root: Path,
) -> None:
    """start is unreplayable, so the bridge must recover through attach alone."""
    with fake_worker() as worker:
        worker.script([_text_update(), _text_update(), _end_turn()])
        bridge, shim, _transport = _bridge(worker, socket_root)
        async with shim:
            run = asyncio.ensure_future(
                bridge.run({"prompt": "p", "cwd": "/repo", "dropAfterSeqs": [1]})
            )
            seen = [await shim.to_agent(), await shim.to_agent(), await shim.to_agent()]
            outcome = await asyncio.wait_for(run, 15)

    assert outcome.reconnects >= 1, "the injected drop must have been observed as a drop"
    assert outcome.stop_reason == "end_turn", "the turn still finished, through attach"
    assert [m.get("method") for m in seen[:2]] == ["session/update", "session/update"]
    assert seen[2]["result"]["stopReason"] == "end_turn"
    assert outcome.duplicates_suppressed == 0, (
        "a single reader resuming from its own watermark never sees an overlap: attach "
        "replays strictly above sinceSeq. Duplicates need two CONCURRENT invokes, which "
        "is what the guard below covers"
    )


@pytest.mark.asyncio
async def test_a_replayed_event_below_the_watermark_is_dropped(socket_root: Path) -> None:
    """The client-side guard, driven at the seam where an overlap would arrive.

    Exercised through ``_drain`` with a canned stream rather than through a live session,
    because a single-reader resume cannot produce the overlap: it takes two concurrent
    invokes on one session -- a live stream plus a stop, or a second viewer -- and each
    delivers from its own ``sinceSeq``. The worker guarantees monotonicity and gap
    announcement, never single delivery, so this guard is the client's obligation.
    """
    with fake_worker() as worker:
        bridge, _shim, _transport = _bridge(worker, socket_root)

    async def replayed() -> AsyncIterator[bytes]:
        for payload in (
            {"type": "status", "phase": "prompting", "seq": 1},
            {"type": "status", "phase": "prompting", "seq": 2},
            {"type": "status", "phase": "prompting", "seq": 1},
            {"type": "status", "phase": "prompting", "seq": 2},
        ):
            yield f"data: {json.dumps(payload)}\n\n".encode("utf-8")

    await bridge._drain(replayed())

    assert bridge.outcome.last_seq == 2
    assert bridge.outcome.duplicates_suppressed == 2


@pytest.mark.asyncio
async def test_a_finished_session_is_not_polled_forever(socket_root: Path) -> None:
    """attach_end.live == false ends the loop even with no terminal event to see."""
    with fake_worker(max_history=16) as worker:
        worker.script([_end_turn()])
        bridge, shim, _transport = _bridge(worker, socket_root)
        async with shim:
            run = asyncio.ensure_future(bridge.run({"prompt": "p", "dropAfterSeqs": [1]}))
            outcome = await asyncio.wait_for(run, 15)
    assert outcome.stop_reason in {"end_turn", "session_gone"}


# ── the input direction ──


@pytest.mark.asyncio
async def test_an_approval_is_delivered_over_the_rpc_action(socket_root: Path) -> None:
    """A message the agent writes reaches the child, and its answer comes back."""
    with fake_worker() as worker:
        worker.script([_text_update(), {"_await_rpc": True}, _end_turn()])
        worker.script_replies(
            {
                "session/request_permission": lambda msg: [
                    {
                        "type": "acp",
                        "payload": {
                            "jsonrpc": "2.0",
                            "id": msg.get("id"),
                            "result": {"outcome": {"outcome": "selected"}},
                        },
                    }
                ]
            }
        )
        bridge, shim, _transport = _bridge(worker, socket_root)
        async with shim:
            run = asyncio.ensure_future(bridge.run({"prompt": "p"}))
            await shim.to_agent()
            await shim.from_agent(
                {"jsonrpc": "2.0", "id": 42, "method": "session/request_permission", "params": {}}
            )
            answer = await shim.to_agent()
            outcome = await asyncio.wait_for(run, 15)

    assert answer["id"] == 42, "the reply must echo the agent's own request id"
    assert outcome.undelivered == 0
    assert outcome.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_an_undelivered_message_is_queued_rather_than_reported_sent(
    socket_root: Path,
) -> None:
    """A failed rpc answers 409, and the bridge must treat that as NOT delivered."""
    with fake_worker() as worker:
        worker.script([_end_turn()])
        bridge, shim, transport = _bridge(worker, socket_root)
        async with shim:
            run = asyncio.ensure_future(bridge.run({"prompt": "p"}))
            outcome = await asyncio.wait_for(run, 10)
            # The session reached its terminal event, so nothing can be delivered now.
            await bridge._deliver({"jsonrpc": "2.0", "id": 7, "method": "session/cancel"})

    assert outcome.stop_reason == "end_turn"
    assert 409 in transport.json_statuses, (
        "an undelivered rpc must come back as 409, which is the signal the bridge "
        "needs to tell a delivered approval from a silently dropped one"
    )
    assert bridge.outcome.undelivered == 1, "and it must be queued for re-send, not lost"


# ── stopping ──


@pytest.mark.asyncio
async def test_stop_escalates_and_reaches_termination(socket_root: Path) -> None:
    """Cooperative cancel, then the worker's stop action, then the platform."""
    with fake_worker() as worker:
        # Parked on an approval that never comes, so the turn cannot end on its own.
        worker.script([_text_update(), {"_await_rpc": True}, _end_turn()])
        bridge, shim, transport = _bridge(worker, socket_root)
        async with shim:
            run = asyncio.ensure_future(bridge.run({"prompt": "p"}))
            await shim.to_agent()
            await bridge.stop()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(run, 10)

    assert bridge.outcome.stop_reason, "stopping must record a terminal reason"
    assert bridge.outcome.stop_reason in {"stopped", "child_exit", "end_turn"}


# ── liveness, which has no pid to consult ──


def test_liveness_reports_no_pid_and_a_remote_identifier() -> None:
    live = RemoteLiveness(session_id="abc", started_at=0.0)
    assert live.runtime_info() == (None, None)
    assert live.identifier == "agentcore:abc"
    assert live.shares_session is False


def test_liveness_is_unknown_before_the_first_frame_and_dead_once_silent() -> None:
    """unknown, not dead, while a cold container is still starting."""
    live = RemoteLiveness(session_id="abc", started_at=0.0)
    verdict, _ = live.check(1.0)
    assert verdict == VERDICT_UNKNOWN

    verdict, evidence = live.check(live.startup_allowance_secs + 1.0)
    assert verdict == VERDICT_DEAD
    assert "emitted nothing" in evidence

    live.note_traffic(100.0, seq=7)
    assert live.check(101.0)[0] == VERDICT_WORKING
    verdict, evidence = live.check(100.0 + live.grace_secs + 1.0)
    assert verdict == VERDICT_DEAD
    assert "seq 7" in evidence


@pytest.mark.asyncio
async def test_the_bridge_feeds_liveness_from_stream_traffic(socket_root: Path) -> None:
    with fake_worker() as worker:
        worker.script([_text_update(), _end_turn()])
        bridge, shim, _transport = _bridge(worker, socket_root)
        async with shim:
            run = asyncio.ensure_future(bridge.run({"prompt": "p"}))
            await shim.to_agent()
            await asyncio.wait_for(run, 10)
    assert bridge.liveness.last_traffic_at is not None
    assert bridge.liveness.last_event_seq >= 1


# ── the worker's answer shape ──


def test_an_unparsable_worker_answer_counts_as_not_delivered() -> None:
    """The pessimistic default is the contract, not a convenience."""
    assert ActionResult.parse("rpc", None).delivered is False
    assert ActionResult.parse("rpc", ["nope"]).delivered is False
    assert ActionResult.parse("rpc", {}).delivered is False
    parsed = ActionResult.parse("rpc", {"action": "rpc", "delivered": True, "seq": 19})
    assert (parsed.delivered, parsed.seq, parsed.reason) == (True, 19, None)


def test_a_true_seq_is_not_read_as_a_sequence_number() -> None:
    """bool is an int in Python, and a seq of True would corrupt a watermark."""
    assert ActionResult.parse("rpc", {"delivered": True, "seq": True}).seq == 0


# ── the keystone leaf ──


def test_runtime_coordinates_fail_closed_when_the_leaf_is_absent(tmp_path: Path) -> None:
    with pytest.raises(BridgeUnconfigured, match="does not exist"):
        load_runtime_coordinates(tmp_path / "agentcore_runtime.json")


def test_runtime_coordinates_fail_closed_on_a_missing_field(tmp_path: Path) -> None:
    leaf = tmp_path / "agentcore_runtime.json"
    leaf.write_text(json.dumps({"region": "us-east-1"}), encoding="utf-8")
    with pytest.raises(BridgeUnconfigured, match="runtime_arn"):
        load_runtime_coordinates(leaf)


def test_runtime_coordinates_defaults_are_facts_not_guesses(tmp_path: Path) -> None:
    leaf = tmp_path / "agentcore_runtime.json"
    leaf.write_text(
        json.dumps({"runtime_arn": "arn:aws:bedrock-agentcore:::runtime/x", "region": "us-east-1"}),
        encoding="utf-8",
    )
    coords = load_runtime_coordinates(leaf)
    assert coords == RuntimeCoordinates(
        runtime_arn="arn:aws:bedrock-agentcore:::runtime/x",
        region="us-east-1",
        endpoint_name="DEFAULT",
        profile="",
    )


# ── envelope invariants ──


def test_a_short_session_id_is_refused_before_a_single_invoke(tmp_path: Path) -> None:
    """The worker answers 400 below 33 characters; refusing here says why."""
    with pytest.raises(ValueError, match="at least 33"):
        AgentCoreBridge(
            HttpTransport("http://127.0.0.1:1"),
            session_id="tooshort",
            owner_token="t",
            socket_path=tmp_path / "s.sock",
        )


def test_a_minted_session_id_clears_the_platform_floor() -> None:
    assert len(mint_session_id()) >= 33


def test_the_spawn_env_names_exactly_the_two_coordinates(tmp_path: Path) -> None:
    bridge = AgentCoreBridge(
        HttpTransport("http://127.0.0.1:1"),
        session_id=mint_session_id(),
        owner_token="tok",
        socket_path=tmp_path / "s.sock",
    )
    assert set(bridge.spawn_env) == {
        "KIROCREW_AGENTCORE_SOCKET",
        "KIROCREW_AGENTCORE_OWNER_TOKEN",
    }
    assert bridge.spawn_env["KIROCREW_AGENTCORE_OWNER_TOKEN"] == "tok"


# ── the import boundary ──

_BLOCK_BOTO3 = textwrap.dedent("""
    import importlib.abc, sys

    class _Block(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path=None, target=None):
            if name == "boto3" or name.startswith("boto3."):
                raise ImportError(f"blocked for this test: {name}")
            return None

    sys.meta_path.insert(0, _Block())
    """)


def test_the_bridge_imports_without_the_aws_sdk() -> None:
    """A public install without the agentcore extra must still import this module.

    In a subprocess with boto3 blocked, because the warm test process imported it long
    ago and an in-process assertion would be vacuous.
    """
    snippet = """
        import kiro_crew.agentcore.bridge as bridge
        assert "boto3" not in __import__("sys").modules, "boto3 was imported at module scope"
        assert bridge.AgentCoreBridge is not None
        print("ok")
    """
    result = subprocess.run(
        [sys.executable, "-B", "-c", _BLOCK_BOTO3 + textwrap.dedent(snippet)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        cwd=str(Path(__file__).resolve().parents[1]),
        env={**__import__("os").environ, "PYTHONPATH": "src"},
    )
    assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
    assert "ok" in result.stdout
