"""Self-test of the fake AgentCore worker fixture (test/agentcore/fake_worker.py).

The contract asserted here is the REAL worker's -- WP1's
`packaging/agentcore-worker/server.mjs` + `hub.mjs`, the container half that
will actually run -- not the Spike C worker the fixture's protocol logic was
ported from. Where the two disagree (the `actionResult` answer shape, 409 on a
failed rpc delivery, the 16-event history floor, `attach_end`'s explicit null
seq, no ACP handshake in the worker) the real worker wins.

Stdlib client only, deliberately at the socket level: the SSE assertions need
frame-at-a-time reads with a short timeout, plus the ability to tell "connection
open but silent" (read times out) from "connection closed" (read returns EOF) --
which is exactly what the `silentAfterSeq` and `dropAfterSeqs` faults differ in,
and which no buffered client exposes.

Every wait is bounded at <= 2 s and no bare sleep exceeds 0.2 s; the tests await
a condition instead.
"""

from __future__ import annotations

import json
import socket
import time
import urllib.parse
import uuid

import pytest

from agentcore.fake_worker import (
    MIN_HISTORY,
    SESSION_ID_HEADER,
    SESSION_ID_MIN_LEN,
    FakeWorker,
    action_result,
    derive_events,
    derive_usage,
    fake_worker,
)

TIMEOUT = 2.0


def sid() -> str:
    """A valid runtime session id: 37 chars (a bare uuid4 hex is 32 -- short)."""
    return "sess-" + uuid.uuid4().hex


# ───────────────────────────── client ─────────────────────────────


class Conn:
    """One HTTP/1.1 request with frame-level control over an SSE body."""

    def __init__(
        self,
        worker: FakeWorker,
        body: dict | None = None,
        *,
        method: str = "POST",
        path: str = "/invocations",
        headers: dict[str, str] | None = None,
        raw_body: bytes | None = None,
        timeout: float = TIMEOUT,
    ) -> None:
        parts = urllib.parse.urlsplit(worker.base_url)
        assert parts.hostname and parts.port
        self.sock = socket.create_connection((parts.hostname, parts.port), timeout=timeout)
        payload = (
            raw_body
            if raw_body is not None
            else (json.dumps(body).encode() if body is not None else b"")
        )
        lines = [
            f"{method} {path} HTTP/1.1",
            f"Host: {parts.hostname}:{parts.port}",
            "Content-Type: application/json",
            f"Content-Length: {len(payload)}",
            "Connection: close",
        ]
        for key, value in (headers or {}).items():
            lines.append(f"{key}: {value}")
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode() + payload)
        self._buf = b""
        self._eof = False
        self.status, self.headers = self._read_head()

    # -- transport -------------------------------------------------------

    def _fill(self, timeout: float) -> str:
        self.sock.settimeout(max(timeout, 0.001))
        try:
            chunk = self.sock.recv(65536)
        except TimeoutError:
            return "timeout"
        if not chunk:
            self._eof = True
            return "closed"
        self._buf += chunk
        return "data"

    def _read_head(self) -> tuple[int, dict[str, str]]:
        deadline = time.monotonic() + TIMEOUT
        while b"\r\n\r\n" not in self._buf:
            assert time.monotonic() < deadline, "no response head"
            assert self._fill(0.25) != "closed", "connection closed before head"
        head, _, self._buf = self._buf.partition(b"\r\n\r\n")
        lines = head.decode().split("\r\n")
        status = int(lines[0].split()[1])
        headers = {}
        for line in lines[1:]:
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()
        return status, headers

    def close(self) -> None:
        self.sock.close()

    def __enter__(self) -> Conn:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- bodies ----------------------------------------------------------

    def json_body(self) -> dict:
        want = int(self.headers.get("content-length", "0"))
        deadline = time.monotonic() + TIMEOUT
        while len(self._buf) < want:
            assert time.monotonic() < deadline, "incomplete JSON body"
            self._fill(0.25)
        return json.loads(self._buf[:want])

    def next_frame(self, timeout: float = TIMEOUT) -> tuple[str, object]:
        """-> ("data", dict) | ("comment", str) | ("timeout", None) | ("closed", None)."""
        deadline = time.monotonic() + timeout
        while True:
            idx = self._buf.find(b"\n\n")
            if idx != -1:
                raw = self._buf[:idx].decode()
                self._buf = self._buf[idx + 2 :]
                if raw.startswith("data: "):
                    return "data", json.loads(raw[len("data: ") :])
                return "comment", raw
            if self._eof:
                return "closed", None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "timeout", None
            self._fill(min(remaining, 0.1))

    def events(self, count: int, timeout: float = TIMEOUT) -> list[dict]:
        """The next ``count`` data frames, skipping `: ping` comments."""
        out: list[dict] = []
        deadline = time.monotonic() + timeout
        while len(out) < count:
            kind, value = self.next_frame(max(deadline - time.monotonic(), 0.0))
            assert kind == "data", f"wanted {count} events, got {kind} after {out}"
            assert isinstance(value, dict)
            out.append(value)
        return out

    def drain(self, timeout: float = TIMEOUT) -> list[dict]:
        """Every data frame until the server closes the stream."""
        out: list[dict] = []
        deadline = time.monotonic() + timeout
        while True:
            kind, value = self.next_frame(max(deadline - time.monotonic(), 0.0))
            if kind == "closed":
                return out
            assert kind != "timeout", f"stream never closed; got {out}"
            if kind == "data":
                assert isinstance(value, dict)
                out.append(value)


def is_sse(conn: Conn) -> bool:
    return conn.headers.get("content-type") == "text/event-stream"


def await_condition(pred, timeout: float = TIMEOUT, what: str = "condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = pred()
        if value:
            return value
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


# ───────────────────────────── scripts ─────────────────────────────

TURN = [
    {"type": "status", "phase": "launching"},
    {"type": "acp", "payload": {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": "acp-7"}}},
    {
        "type": "acp",
        "payload": {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "meteringUsage": [{"value": 1.5}, {"value": 0.5}],
                "contextUsagePercentage": 12,
            },
        },
    },
    {"type": "acp", "payload": {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}},
]


def ticks(n: int) -> list[dict]:
    """`n` plain, non-terminal events -- no acp payloads, no `done`."""
    return [{"type": "status", "phase": "tick", "n": i} for i in range(n)]


def start_body(session: str, **extra: object) -> dict:
    return {"action": "start", "runtimeSessionId": session, **extra}


# ───────────────────────── derivation (pure) ─────────────────────────


def test_derive_events_is_pure_over_the_message():
    msg = {"jsonrpc": "2.0", "id": 3, "result": {"stopReason": "end_turn"}}
    before = json.dumps(msg, sort_keys=True)
    out = derive_events(msg)
    assert [e["type"] for e in out] == ["acp", "status", "done"]
    assert out[1]["phase"] == "turn_end"
    assert out[2]["stopReason"] == "end_turn"
    assert json.dumps(msg, sort_keys=True) == before
    assert all("seq" not in e for e in out)


def test_derive_usage_is_advisory_and_tolerant():
    usage = derive_usage(
        {"meteringUsage": [{"value": 1.5}, {"value": "x"}, 0.25], "contextUsagePercentage": 7}
    )
    # `advisory` is on the wire: the same credits are already in the acp frame,
    # so a client that sums both double-counts.
    assert usage == {
        "type": "usage",
        "advisory": True,
        "credits": 1.75,
        "entries": 3,
        "contextUsagePercentage": 7,
    }
    assert derive_usage({}) is None
    assert derive_usage({"meteringUsage": []}) is None
    assert derive_usage({"meteringUsage": [{}]})["contextUsagePercentage"] is None


def test_action_result_always_carries_all_four_keys():
    assert action_result("rpc") == {
        "action": "rpc",
        "delivered": False,
        "seq": 0,
        "reason": None,
    }
    assert action_result("rpc", delivered=True, seq=4) == {
        "action": "rpc",
        "delivered": True,
        "seq": 4,
        "reason": None,
    }


# ───────────────────────────── happy path ─────────────────────────────


def test_ping_reports_health_and_a_live_session_count():
    with fake_worker() as worker:
        worker.script(ticks(2))
        with Conn(worker, method="GET", path="/ping") as conn:
            assert conn.status == 200
            # The real worker answers a COUNT, not a list of ids.
            assert conn.json_body() == {"status": "Healthy", "sessions": 0}

        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.events(1)
            with Conn(worker, method="GET", path="/ping") as conn:
                assert conn.json_body() == {"status": "Healthy", "sessions": 1}
        assert worker.sessions() == [session]


def test_scripted_turn_streams_and_ends_with_done():
    with fake_worker() as worker:
        worker.script(TURN)
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            assert stream.status == 200
            assert is_sse(stream)
            assert stream.headers["cache-control"] == "no-cache"
            assert stream.headers[SESSION_ID_HEADER.lower()] == session
            events = stream.drain()

        assert [e["type"] for e in events] == [
            "status",
            "acp",
            "acp",
            "usage",
            "acp",
            "status",
            "done",
        ]
        assert [e["seq"] for e in events] == [1, 2, 3, 4, 5, 6, 7]
        usage = events[3]
        assert usage["advisory"] is True
        assert usage["credits"] == 2.0
        assert usage["entries"] == 2
        assert usage["contextUsagePercentage"] == 12
        assert events[5]["phase"] == "turn_end"
        assert events[6]["stopReason"] == "end_turn"
        # `done` is terminal for the session, so it is no longer live.
        assert worker.sessions() == []


def test_the_session_id_header_wins_over_the_body():
    with fake_worker() as worker:
        worker.script(ticks(1))
        header_session, body_session = sid(), sid()
        headers = {SESSION_ID_HEADER: header_session}
        body = {"action": "start", "runtimeSessionId": body_session}
        with Conn(worker, body, headers=headers) as stream:
            assert stream.events(1)[0]["seq"] == 1
        assert worker.sessions() == [header_session]


def test_owner_token_is_read_from_the_body_alone():
    with fake_worker() as worker:
        worker.script(ticks(1))
        session, token = sid(), "owner-" + uuid.uuid4().hex
        with Conn(worker, start_body(session, ownerToken=token)) as stream:
            stream.events(1)

        with Conn(
            worker,
            {"action": "attach", "runtimeSessionId": session, "ownerToken": token},
        ) as conn:
            assert conn.status == 200
        # The real worker has no owner-token HEADER, so sending it there is not
        # authentication -- it is a mismatch.
        with Conn(
            worker,
            {"action": "attach", "runtimeSessionId": session},
            headers={"X-Owner-Token": token},
        ) as conn:
            assert conn.status == 403


def test_a_missing_action_is_a_start():
    with fake_worker() as worker:
        worker.script(ticks(1))
        session = sid()
        with Conn(worker, {"runtimeSessionId": session}) as stream:
            assert stream.status == 200
            assert is_sse(stream)
            assert stream.events(1)[0]["seq"] == 1
        assert worker.sessions() == [session]


def test_stop_emits_stopping_then_done():
    with fake_worker() as worker:
        worker.script(ticks(1))
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.events(1)
        with Conn(worker, {"action": "stop", "runtimeSessionId": session}) as conn:
            assert is_sse(conn)
            events = conn.drain()
        assert [e["type"] for e in events] == ["status", "done"]
        assert events[0]["phase"] == "stopping"
        assert events[1]["stopReason"] == "stopped"
        assert events[1]["exitCode"] is None
        assert worker.sessions() == []


# ───────────────────────────── rpc contract ─────────────────────────────


def test_rpc_answers_json_and_releases_a_scripted_approval():
    script = [
        {"type": "status", "phase": "awaiting_approval"},
        {"type": "status", "phase": "resumed", "_await_rpc": True},
        TURN[-1],
    ]
    with fake_worker() as worker:
        worker.script(script)
        session = sid()
        with Conn(worker, start_body(session, slowApprovalMs=60)) as stream:
            assert stream.events(1)[0]["phase"] == "awaiting_approval"
            # The script is parked on the approval: nothing more arrives.
            assert stream.next_frame(0.2)[0] == "timeout"

            t0 = time.monotonic()
            with Conn(
                worker,
                {
                    "action": "rpc",
                    "runtimeSessionId": session,
                    "message": {
                        "jsonrpc": "2.0",
                        "id": 9,
                        "method": "session/request_permission_response",
                    },
                },
            ) as rpc:
                assert rpc.status == 200
                assert not is_sse(rpc)
                answer = rpc.json_body()
            elapsed_ms = (time.monotonic() - t0) * 1000

            # The ONE result shape -- no `ok`, no `deliveredAtSeq`, no
            # `deliverMs`; all four keys always present.
            assert set(answer) == {"action", "delivered", "seq", "reason"}
            assert answer["action"] == "rpc"
            assert answer["delivered"] is True
            assert answer["reason"] is None
            assert elapsed_ms >= 60  # slowApprovalMs delayed the delivery

            rest = stream.drain()

        delivered = rest[0]
        assert delivered["type"] == "status"
        assert delivered["phase"] == "rpc_delivered"
        assert delivered["rpcId"] == 9
        assert delivered["method"] == "session/request_permission_response"
        assert delivered["delivered"] is True
        # `seq` locates the caller's OWN delivery in the transcript.
        assert answer["seq"] == delivered["seq"] == 2
        assert [e.get("phase") for e in rest[:2]] == ["rpc_delivered", "resumed"]
        assert rest[-1]["type"] == "done"


def test_failed_rpc_delivery_answers_409_and_records_the_drop():
    with fake_worker() as worker:
        worker.script(TURN)
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.drain()
        assert worker.sessions() == []

        with Conn(
            worker,
            {
                "action": "rpc",
                "runtimeSessionId": session,
                "message": {"jsonrpc": "2.0", "id": 4, "method": "session/cancel"},
            },
        ) as rpc:
            # A failed delivery is 409, not 200 -- the bridge's "was my approval
            # delivered?" logic reads the status.
            assert rpc.status == 409
            answer = rpc.json_body()
        assert answer == {
            "action": "rpc",
            "delivered": False,
            "seq": 0,  # the hub is closed, so nothing was recorded
            "reason": "the agent child is not accepting input",
        }


# ──────────────────── the handshake the worker does NOT do ────────────────────


def acp(payload: dict) -> dict:
    return {"type": "acp", "payload": payload}


def test_full_handshake_is_driven_by_the_client_over_rpc():
    """server.mjs:624-626 -- the worker performs no handshake at all.

    The client drives `initialize`, `session/new` and `session/prompt` through
    `rpc` and the worker forwards them, so a bridge test has to be able to
    script the child's REPLY to each, echoing the caller's own id.
    """
    with fake_worker() as worker:
        worker.script([])  # nothing canned: the client drives everything
        worker.script_replies(
            {
                "initialize": lambda msg: [
                    acp(
                        {
                            "jsonrpc": "2.0",
                            "id": msg["id"],
                            "result": {"protocolVersion": 1},
                        }
                    )
                ],
                "session/new": lambda msg: [
                    acp(
                        {
                            "jsonrpc": "2.0",
                            "id": msg["id"],
                            "result": {"sessionId": "acp-session-42"},
                        }
                    )
                ],
                "session/prompt": lambda msg: [
                    acp(
                        {
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": "READY"},
                            },
                        }
                    ),
                    acp(
                        {
                            "jsonrpc": "2.0",
                            "id": msg["id"],
                            "result": {"stopReason": "end_turn"},
                        }
                    ),
                ],
            }
        )
        session = sid()

        def call(rpc_id: int, method: str, params: dict) -> dict:
            body = {
                "action": "rpc",
                "runtimeSessionId": session,
                "message": {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "method": method,
                    "params": params,
                },
            }
            with Conn(worker, body) as conn:
                assert conn.status == 200
                answer = conn.json_body()
            assert answer["delivered"] is True and answer["reason"] is None
            return answer

        with Conn(worker, start_body(session)) as stream:
            # An empty script emits nothing: the stream is quiet until the
            # first rpc, because the worker asserts no protocol version.
            assert stream.next_frame(0.2)[0] == "timeout"

            init = call(1, "initialize", {"protocolVersion": 1})
            delivered, reply = stream.events(2)
            assert delivered["phase"] == "rpc_delivered"
            assert delivered["seq"] == init["seq"] == 1
            assert reply["type"] == "acp"
            assert reply["payload"]["id"] == 1  # echoes the caller's own id
            assert reply["payload"]["result"] == {"protocolVersion": 1}

            call(2, "session/new", {"cwd": "/tmp/x", "mcpServers": []})
            delivered, reply = stream.events(2)
            assert delivered["method"] == "session/new"
            assert reply["payload"]["id"] == 2
            assert reply["payload"]["result"]["sessionId"] == "acp-session-42"

            call(3, "session/prompt", {"sessionId": "acp-session-42", "prompt": []})
            rest = stream.drain()

        # The prompt's own reply is what ends the turn: the text update, then
        # the stopReason result, from which the fixture derives turn_end + done.
        assert [e["type"] for e in rest] == ["status", "acp", "acp", "status", "done"]
        assert rest[0]["phase"] == "rpc_delivered"
        assert rest[1]["payload"]["params"]["content"]["text"] == "READY"
        assert rest[2]["payload"]["id"] == 3
        assert rest[3]["phase"] == "turn_end"
        assert rest[3]["stopReason"] == "end_turn"
        assert rest[4]["stopReason"] == "end_turn"
        assert [e["seq"] for e in rest] == [5, 6, 7, 8, 9]
        assert worker.sessions() == []


def test_script_and_script_replies_coexist():
    with fake_worker() as worker:
        worker.script([{"type": "status", "phase": "awaiting_approval"}])
        worker.script_replies(
            {"session/cancel": lambda msg: [{"type": "done", "stopReason": "cancelled"}]}
        )
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            assert stream.events(1)[0]["phase"] == "awaiting_approval"
            with Conn(
                worker,
                {
                    "action": "rpc",
                    "runtimeSessionId": session,
                    "message": {"jsonrpc": "2.0", "id": 5, "method": "session/cancel"},
                },
            ) as conn:
                assert conn.status == 200
            rest = stream.drain()
        assert [e["type"] for e in rest] == ["status", "done"]
        assert rest[-1]["stopReason"] == "cancelled"


# ───────────────────────────── fault injection ─────────────────────────────


def test_drop_after_seqs_closes_without_a_terminal_event_then_attach_resumes():
    with fake_worker() as worker:
        worker.script(ticks(6) + [TURN[-1]])
        session = sid()

        with Conn(worker, start_body(session, dropAfterSeqs=[3])) as stream:
            dropped = stream.drain()
        assert [e["seq"] for e in dropped] == [1, 2, 3]
        assert all(e["type"] != "done" for e in dropped)

        # A second `start` is 409 whatever it carries, so the resume is an
        # `attach` -- and it picks up contiguously at seq 4.
        with Conn(worker, start_body(session, sinceSeq=3)) as conn:
            assert conn.status == 409
        resumed = await_condition(
            lambda: (lambda got: got if got and got[-2]["type"] == "done" else None)(
                attach(worker, session, since=3)
            ),
            what="the rest of the script to reach the history",
        )
        assert [e["seq"] for e in resumed[:-1]] == [4, 5, 6, 7, 8, 9]
        assert resumed[-2]["type"] == "done"
        assert dropped[-1]["seq"] + 1 == resumed[0]["seq"]


def attach(worker: FakeWorker, session: str, since: int = 0) -> list[dict]:
    with Conn(
        worker,
        {"action": "attach", "runtimeSessionId": session, "sinceSeq": since},
    ) as conn:
        assert conn.status == 200
        assert is_sse(conn)
        return conn.drain()


def test_attach_is_never_armed_for_a_drop():
    with fake_worker() as worker:
        worker.script(ticks(4))
        session = sid()
        with Conn(worker, start_body(session, dropAfterSeqs=[2])) as stream:
            assert [e["seq"] for e in stream.drain()] == [1, 2]
        events = await_condition(
            lambda: (lambda got: got if len(got) == 5 else None)(attach(worker, session)),
            what="the whole script to reach the history",
        )
        assert [e["seq"] for e in events[:4]] == [1, 2, 3, 4]
        assert events[-1]["type"] == "attach_end"


def test_fatal_after_seq_ends_the_session_and_a_later_attach_is_not_live():
    with fake_worker() as worker:
        # Plain ticks: no acp message ever arrives, which is exactly the quiet
        # session the spike's `_on_child_message`-only check could not fire on.
        worker.script(ticks(6))
        session = sid()
        with Conn(worker, start_body(session, fatalAfterSeq=2)) as stream:
            events = stream.drain()

        assert [e["type"] for e in events] == ["status", "status", "error"]
        assert events[-1]["fatal"] is True
        assert events[-1]["seq"] == 3
        assert worker.sessions() == []

        with Conn(worker, {"action": "attach", "runtimeSessionId": session}) as conn:
            replay = conn.drain()
        assert [e["seq"] for e in replay[:3]] == [1, 2, 3]
        end = replay[-1]
        assert end["type"] == "attach_end"
        assert end["live"] is False
        assert end["lastSeq"] == 3


def test_silent_after_seq_holds_the_connection_open_and_emits_nothing():
    with fake_worker(keepalive_secs=0.05) as worker:
        worker.script(ticks(2))
        session = sid()

        with Conn(worker, start_body(session, silentAfterSeq=1)) as stream:
            assert [e["seq"] for e in stream.events(2)] == [1, 2]
            # Open, but silent: no data, no `: ping`, and no EOF either.
            assert stream.next_frame(0.6)[0] == "timeout"
            assert stream.next_frame(0.3)[0] == "timeout"

        # Control: the same quiet session without the switch keeps pinging.
        with Conn(worker, start_body(sid())) as stream:
            stream.events(2)
            assert stream.next_frame(0.6) == ("comment", ": ping")


def drain_start_to(stream: Conn, last_seq: int) -> list[dict]:
    """Read a live start stream until `last_seq` arrives.

    The script can outrun the subscriber, in which case the live stream itself
    opens on the replay (gap first); either way it arrives at `last_seq`.
    """
    seen: list[dict] = []
    while not seen or seen[-1]["seq"] < last_seq:
        seen.extend(stream.events(1))
    return seen


def test_max_history_forces_a_history_gap():
    with fake_worker() as worker:
        worker.script(ticks(40))
        session = sid()
        with Conn(worker, start_body(session, maxHistory=MIN_HISTORY)) as stream:
            assert drain_start_to(stream, 40)[-1]["seq"] == 40

        replay = attach(worker, session)

        gap = replay[0]
        assert gap["type"] == "history_gap"
        assert gap["throughSeq"] == 40 - MIN_HISTORY  # 24
        assert gap["droppedEvents"] == 40 - MIN_HISTORY
        # The gap's seq restates the prune watermark, it is not a fresh number.
        assert gap["seq"] == gap["throughSeq"]
        assert "pruned" in gap["message"]
        assert [e["seq"] for e in replay[1:-1]] == list(range(25, 41))
        assert replay[-1]["type"] == "attach_end"
        assert replay[-1]["lastSeq"] == 40


def test_max_history_below_the_floor_is_clamped_to_16():
    with fake_worker() as worker:
        worker.script(ticks(40))
        session = sid()
        # hub.mjs:43 -- production cannot honour 8, so the fixture must not
        # pretend it can: the retained window is 16 either way.
        with Conn(worker, start_body(session, maxHistory=8)) as stream:
            assert drain_start_to(stream, 40)[-1]["seq"] == 40

        replay = attach(worker, session)
        assert replay[0]["throughSeq"] == 24
        assert len([e for e in replay if e["type"] == "status"]) == MIN_HISTORY


# ───────────────────────────── attach_end ─────────────────────────────


def test_attach_end_carries_an_explicit_null_seq():
    with fake_worker() as worker:
        worker.script(TURN)
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.drain()

        replay = attach(worker, session)

        end = replay[-1]
        # The explicit null is part of the contract: a client keying on the
        # PRESENCE of `seq` must still see the key.
        assert end == {
            "type": "attach_end",
            "seq": None,
            "live": False,
            "lastSeq": 7,
        }
        assert end["seq"] is None
        assert end["type"] != "status"  # not the spike's status/attach_end


def test_attach_reports_live_for_a_running_session():
    with fake_worker() as worker:
        worker.script(ticks(2))
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.events(2)
            replay = attach(worker, session, since=1)
        assert [e["seq"] for e in replay[:-1]] == [2]
        assert replay[-1] == {
            "type": "attach_end",
            "seq": None,
            "live": True,
            "lastSeq": 2,
        }


# ───────────────────────────── rejections ─────────────────────────────


def assert_rejected(conn: Conn, status: int, action: str = "start") -> dict:
    """Every rejection is an `actionResult` with the cause in `reason`."""
    assert conn.status == status
    assert not is_sse(conn), "a rejected action must never open a stream"
    body = conn.json_body()
    assert set(body) == {"action", "delivered", "seq", "reason"}, body
    assert body["action"] == action
    assert body["delivered"] is False
    assert isinstance(body["seq"], int)
    assert isinstance(body["reason"], str) and body["reason"]
    return body


def test_400_session_id_shorter_than_33_chars():
    with fake_worker() as worker:
        short = uuid.uuid4().hex  # 32 -- one short of the contract
        assert len(short) == SESSION_ID_MIN_LEN - 1
        with Conn(worker, start_body(short)) as conn:
            body = assert_rejected(conn, 400)
        assert "33" in body["reason"]
        assert "32" in body["reason"]


def test_400_malformed_json_body():
    with fake_worker() as worker:
        with Conn(worker, raw_body=b'{"action": "start"') as conn:
            body = assert_rejected(conn, 400, action="unknown")
        assert body["reason"] == "invalid JSON payload"
        # A well-formed non-object payload is not a parse failure: it is
        # treated as an empty body, so it fails on the session id instead.
        with Conn(worker, raw_body=b'["start"]') as conn:
            assert_rejected(conn, 400)


def test_400_unknown_action_is_checked_after_the_session_lookup():
    with fake_worker() as worker:
        worker.script(ticks(1))
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.events(1)
        with Conn(worker, {"action": "frobnicate", "runtimeSessionId": session}) as conn:
            body = assert_rejected(conn, 400, action="frobnicate")
        assert "frobnicate" in body["reason"]
        # Same unknown action on an UNKNOWN session is 404, not 400: the action
        # name is validated last (server.mjs:859).
        with Conn(worker, {"action": "frobnicate", "runtimeSessionId": sid()}) as conn:
            assert_rejected(conn, 404, action="frobnicate")


def test_409_rpc_without_a_message_object():
    with fake_worker() as worker:
        worker.script(ticks(1))
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.events(1)
        for bad in ({}, {"message": "hello"}, {"message": [1]}):
            with Conn(worker, {"action": "rpc", "runtimeSessionId": session, **bad}) as conn:
                # A malformed message is a failed DELIVERY, so it takes the
                # same 409 as any other undelivered rpc (server.mjs:848).
                body = assert_rejected(conn, 409, action="rpc")
            assert body["reason"] == "rpc requires a JSON-RPC `message` object"
            assert body["seq"] == 0


def test_403_owner_token_mismatch():
    with fake_worker() as worker:
        worker.script(ticks(1))
        session, token = sid(), "owner-" + uuid.uuid4().hex
        with Conn(worker, start_body(session, ownerToken=token)) as stream:
            stream.events(1)
        with Conn(
            worker,
            {
                "action": "attach",
                "runtimeSessionId": session,
                "ownerToken": "owner-wrong",
            },
        ) as conn:
            body = assert_rejected(conn, 403, action="attach")
        assert "owner token" in body["reason"]
        with Conn(
            worker, {"action": "attach", "runtimeSessionId": session, "ownerToken": token}
        ) as conn:
            assert conn.status == 200


@pytest.mark.parametrize("action", ["rpc", "attach", "stop"])
def test_404_unknown_session_on_every_action_except_start(action):
    with fake_worker() as worker:
        body = {"action": action, "runtimeSessionId": sid()}
        if action == "rpc":
            body["message"] = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
        with Conn(worker, body) as conn:
            answer = assert_rejected(conn, 404, action=action)
        assert "start" in answer["reason"]


def test_404_unknown_route_is_the_one_error_shaped_body():
    with fake_worker() as worker:
        for conn_kwargs in (
            {"body": {"action": "start"}, "path": "/nope"},
            {"method": "GET", "path": "/nope"},
            {"method": "GET", "path": "/invocations"},
            {"body": {"action": "start"}, "path": "/ping"},
        ):
            with Conn(worker, **conn_kwargs) as conn:  # type: ignore[arg-type]
                assert conn.status == 404
                assert not is_sse(conn)
                # The ONE exception to the actionResult rule (server.mjs:877).
                assert conn.json_body() == {"error": "Not found"}


def test_409_start_on_an_already_started_session_whatever_it_carries():
    with fake_worker() as worker:
        worker.script(ticks(3))
        session = sid()
        with Conn(worker, start_body(session)) as stream:
            stream.events(1)  # proves the session has started
            with Conn(worker, start_body(session)) as conn:
                body = assert_rejected(conn, 409)
            assert "already started" in body["reason"]
            # `seq` reports where the session actually is, not 0.
            assert body["seq"] >= 1
            # There is no `sinceSeq` resume exemption: a client that lost its
            # stream re-reads with `attach`, never with a second `start`.
            with Conn(worker, start_body(session, sinceSeq=0)) as conn:
                assert_rejected(conn, 409)


def test_429_more_than_max_sessions_live():
    with fake_worker(max_sessions=2) as worker:
        worker.script(ticks(1))  # no terminal event: sessions stay live
        held = []
        for _ in range(2):
            conn = Conn(worker, start_body(sid()))
            conn.events(1)
            held.append(conn)
        assert len(worker.sessions()) == 2

        with Conn(worker, start_body(sid())) as conn:
            body = assert_rejected(conn, 429)
        assert "2 active" in body["reason"]

        # A freed slot lets the next session in.
        with Conn(worker, {"action": "stop", "runtimeSessionId": worker.sessions()[0]}) as conn:
            conn.drain()
        assert len(worker.sessions()) == 1
        with Conn(worker, start_body(sid())) as conn:
            assert conn.status == 200
        for conn in held:
            conn.close()


# ───────────────────────────── fixture plumbing ─────────────────────────────


def test_base_url_is_only_resolved_after_start():
    worker = FakeWorker()
    with pytest.raises(RuntimeError):
        worker.base_url
    worker.start()
    try:
        assert worker.base_url.startswith("http://127.0.0.1:")
        assert urllib.parse.urlsplit(worker.base_url).port != 8123
    finally:
        worker.stop()
        worker.stop()  # idempotent


def test_two_workers_do_not_share_session_state():
    with fake_worker() as one, fake_worker() as two:
        one.script(ticks(1))
        two.script(ticks(1))
        assert one.base_url != two.base_url
        session = sid()
        with Conn(one, start_body(session)) as stream:
            stream.events(1)
        assert one.sessions() == [session]
        assert two.sessions() == []
        with Conn(two, {"action": "attach", "runtimeSessionId": session}) as conn:
            assert_rejected(conn, 404, action="attach")


def test_import_writes_nothing_and_needs_no_network():
    import agentcore.fake_worker as module

    assert not hasattr(module, "LOGDIR")
    assert not hasattr(module, "SESSIONS")
    assert not hasattr(module, "DEFAULTS")
    assert "subprocess" not in vars(module)
