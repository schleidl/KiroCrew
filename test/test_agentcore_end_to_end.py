"""WP4 step 1: the whole remote path, end to end, with no AWS and no container.

Every other agentcore test drives one piece. This one drives the composition, and the
only substituted part is the AWS call itself:

    a real ``stdio_shim`` SUBPROCESS  ←UNIX socket→  the real bridge  ←HTTP→  a scripted worker

That matters because the shim is the piece whose contract is easiest to describe wrongly
and hardest to notice: it BINDS and listens while the bridge dials, it reads an
owner-token line before relaying anything, it relays opaque bytes in both directions, and
it exits on socket EOF. A test that faked the shim would assert the bridge against this
file's own idea of the shim rather than against the shim.

What is NOT asserted here: a completion event in a parent chat session and a transcript on
disk. Those need a full ``SubagentManager`` spawn, whose local path spawns a real
``kiro-cli``; the remote path's own local process is only this relay, so the seam that
still has to be exercised for that is provider construction rather than anything in this
file. The plan's WP4 step 1 asked for the transcript form of this proof; this is the
strongest form available without a live gateway, and the difference is stated rather than
glossed.
"""

from __future__ import annotations

import asyncio
import http.client
import json
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from agentcore.fake_worker import fake_worker
from kiro_crew.agentcore.bridge import (
    AgentCoreBridge,
    mint_owner_token,
    mint_session_id,
    prepare_remote_session,
    socket_path_for,
)
from kiro_crew.agentcore.stdio_shim import OWNER_TOKEN_ENV, shim_argv


@pytest.fixture()
def socket_root() -> Iterator[Path]:
    """Short enough for AF_UNIX -- see test_agentcore_bridge.py's fixture."""
    root = Path(tempfile.mkdtemp(prefix="kce-", dir="/tmp"))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


class HttpTransport:
    """The worker's HTTP contract. The one piece a real deployment does over SigV4."""

    def __init__(self, base_url: str) -> None:
        host, _, port = base_url.removeprefix("http://").partition(":")
        self._host, self._port = host, int(port)
        self.stopped: list[str] = []

    def _conn(self) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self._host, self._port, timeout=10)

    async def invoke_stream(self, body: dict[str, Any]) -> AsyncIterator[bytes]:
        conn = self._conn()
        await asyncio.to_thread(
            conn.request,
            "POST",
            "/invocations",
            json.dumps(body),
            {"Content-Type": "application/json"},
        )
        response = await asyncio.to_thread(conn.getresponse)
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
        conn = self._conn()
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
            try:
                return response.status, json.loads(raw.decode("utf-8") or "null")
            except ValueError:
                return response.status, None
        finally:
            conn.close()

    async def stop_session(self, session_id: str) -> None:
        self.stopped.append(session_id)


@pytest.mark.asyncio
async def test_a_remote_turn_reaches_a_real_shim_subprocess(socket_root: Path) -> None:
    """The composition: worker events arrive on the shim's stdout as JSON-RPC lines.

    The shim is launched exactly as the harness launches it -- ``shim_argv(socket_path)``
    with the owner token in its environment and nothing in argv -- so this also asserts
    that the harness's argv is runnable, which no unit test of the harness can.
    """
    session_id = mint_session_id()
    token = mint_owner_token()
    socket_path = socket_path_for(session_id, root=socket_root)

    with fake_worker() as worker:
        worker.script(
            [
                {
                    "type": "acp",
                    "payload": {
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {"update": {"sessionUpdate": "agent_message_chunk"}},
                    },
                },
                {
                    "type": "acp",
                    "payload": {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}},
                },
            ]
        )

        shim = subprocess.Popen(
            [sys.executable, *shim_argv(str(socket_path))[1:]],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**_clean_env(), OWNER_TOKEN_ENV: token},
        )
        try:
            bridge = AgentCoreBridge(
                HttpTransport(worker.base_url),
                session_id=session_id,
                owner_token=token,
                socket_path=socket_path,
                poll_interval_ms=40,
                dial_timeout_secs=10.0,
            )
            outcome = await asyncio.wait_for(bridge.run({"prompt": "hi"}), 20)

            assert shim.stdout is not None
            lines = await asyncio.to_thread(shim.stdout.read)
            frames = [
                json.loads(line) for line in lines.decode("utf-8").splitlines() if line.strip()
            ]
        finally:
            shim.kill()
            shim.wait(timeout=5)

    assert outcome.stop_reason == "end_turn"
    assert [f.get("method") for f in frames][:1] == ["session/update"], (
        "the worker's acp payloads must arrive on the shim's STDOUT, newline-framed, "
        "which is what AcpClient reads"
    )
    assert frames[-1]["result"]["stopReason"] == "end_turn"


@pytest.mark.asyncio
async def test_the_shim_refuses_a_bridge_with_the_wrong_token(socket_root: Path) -> None:
    """The owner token is the only thing standing between the relay and any local peer."""
    session_id = mint_session_id()
    socket_path = socket_path_for(session_id, root=socket_root)

    shim = subprocess.Popen(
        [sys.executable, *shim_argv(str(socket_path))[1:]],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**_clean_env(), OWNER_TOKEN_ENV: "the-real-token"},
    )
    try:
        with fake_worker() as worker:
            bridge = AgentCoreBridge(
                HttpTransport(worker.base_url),
                session_id=session_id,
                owner_token="not-the-real-token",
                socket_path=socket_path,
                poll_interval_ms=40,
                dial_timeout_secs=10.0,
            )
            worker.script([{"type": "acp", "payload": {"jsonrpc": "2.0", "id": 1, "result": {}}}])
            with pytest.raises((asyncio.TimeoutError, Exception)):
                await asyncio.wait_for(bridge.run({}), 8)
        rc = shim.wait(timeout=8)
    finally:
        shim.kill()

    assert rc == 3, "EXIT_REFUSED: a token mismatch is a refusal, not a silent relay"


def test_prepare_remote_session_accepts_an_injected_transport(socket_root: Path) -> None:
    """The seam the test above needs, and the reason it needs no keystone leaf."""

    class _T:
        async def invoke_stream(self, body: dict) -> AsyncIterator[bytes]:  # pragma: no cover
            yield b""

        async def invoke_json(self, body: dict) -> tuple[int, object]:  # pragma: no cover
            return 200, {}

        async def stop_session(self, session_id: str) -> None:  # pragma: no cover
            return None

    bridge = prepare_remote_session(socket_root=socket_root, transport=_T())
    assert set(bridge.spawn_env) == {
        "KIROCREW_AGENTCORE_SOCKET",
        "KIROCREW_AGENTCORE_OWNER_TOKEN",
    }


def _clean_env() -> dict[str, str]:
    """A minimal environment: PATH plus what an interpreter needs to import the package."""
    import os

    keep = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PYTHONHASHSEED")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    return env
