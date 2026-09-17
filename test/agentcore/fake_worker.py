"""In-process fake AgentCore worker: HTTP ``/ping`` + ``/invocations`` (SSE).

A pytest-usable port of the Spike C worker
(``agentcore-remote-agents/spike-c/worker.py``, stdlib only) that spawns no
``kiro-cli acp`` child and needs no network. The protocol surface -- seq
stamping, bounded history with immortal terminal events, ``history_gap``
synthesis, the SSE framing, the request envelope, the owner-token rule, the
four route handlers -- is behaviour-identical to the spike. The child is
replaced by a canned event script (:meth:`FakeWorker.script`), which is emitted
through the same :class:`Hub`, so seqs are assigned exactly as in production.

Ported from the spike
---------------------
* ``Hub`` (worker.py:62-143) -- verbatim: ``emit`` seq stamping, the prune that
  evicts only NON-terminal events, ``_replay_into``'s ``history_gap``,
  ``subscribe`` / ``replay_only`` / ``unsubscribe`` / ``close``.
* SSE helpers (349-371) -- ``_json``, ``_open_sse``, ``_sse`` (``data: {json}``
  only; the seq travels INSIDE the JSON), ``_keepalive`` (``: ping``).
* The live pump ``_stream`` (435-461) incl. the drop-injection hook.
* The request envelope + auth block (384-420): session id from body
  ``runtimeSessionId`` or header
  ``X-Amzn-Bedrock-AgentCore-Runtime-Session-Id``; owner token from body
  ``ownerToken`` or header ``X-Owner-Token``; the >= 33-char session-id rule.
* Route handlers ``_do_start`` / ``_do_rpc`` / ``_do_attach`` / ``_do_stop``
  (463-512) and ``GET /ping`` (374-382).
* The event-derivation RULES of ``_on_child_message`` (218-247), lifted into the
  pure functions :func:`derive_events` / :func:`derived_acp_session_id`.

Dropped from the spike
----------------------
* Real-child coupling: ``start_child`` / ``_reap`` / ``_pump_stdout``
  (171-216) and ``_handshake_and_prompt`` / ``_saw_response`` / ``_wait_for`` /
  ``send_to_child`` (249-308). No subprocess.
* ``HERE`` / ``LOGDIR`` + the import-time ``os.makedirs`` (39-41), the raw log
  at L167 and the child stderr file at L181 -- an importable test module must
  not touch the filesystem at import.
* Module globals ``SESSIONS`` / ``SESSIONS_LOCK`` / ``DEFAULTS`` (333-335), now
  :class:`FakeWorker` instance attributes so pytest-xdist workers cannot
  cross-contaminate.
* ``log()`` (54-56) and ``Handler.log_message`` (344-346) -- the server is
  silent.
* ``main()`` and argparse (515-531); the fixed port 8123 is gone, the server
  binds ``("127.0.0.1", 0)``.

Defects fixed here (the spike is wrong; do not "restore" these)
--------------------------------------------------------------
* ``fatalAfterSeq`` is evaluated in the EMIT path, not inside
  ``_on_child_message``, so it fires deterministically on a session that never
  produces a child message.
* A fatal error is terminal for the SESSION, not just the stream: emitting
  ``error{fatal: true}`` ends the session and closes the hub (the spike left
  the child running with nobody attached), matching ``failSession``
  (server.mjs:481-486).

THE AUTHORITATIVE CONTRACT IS THE REAL WORKER, NOT THE SPIKE
------------------------------------------------------------
Wire shapes and statuses below are matched against the container half that
will actually run -- ``packaging/agentcore-worker/server.mjs`` and
``hub.mjs`` of WP1 -- not against the spike, which diverges:

* every non-streaming answer is ONE shape, ``actionResult``
  (server.mjs:127-134): ``{action, delivered, seq, reason}``, all four keys
  always present. ``seq`` is the seq of the ``status`` event recording the
  attempt and is ``0`` when nothing was recorded (a closed hub), so a client
  can never mistake somebody else's event for its own delivery.
* a FAILED ``rpc`` answers **409**, a delivered one 200 (server.mjs:848).
* every rejection answers that same ``actionResult`` with the cause in
  ``reason``. The one exception is an unknown ROUTE, which answers
  ``{"error": "Not found"}`` (server.mjs:877).
* ``maxHistory`` has a floor of 16 (hub.mjs:43).
* ``attach_end`` carries an explicit ``"seq": null`` beside ``type``, ``live``
  and ``lastSeq`` (server.mjs:718-722), and is written to that one response
  only -- never hub-stamped.
* the worker performs NO ACP handshake (server.mjs:624-626): the client drives
  ``initialize`` / ``session/new`` / ``session/prompt`` through ``rpc`` and the
  worker forwards them. :meth:`FakeWorker.script_replies` is how a test fakes
  the child's answers to those.
* a missing ``action`` defaults to ``"start"`` (server.mjs:826), and an unknown
  action is rejected only AFTER the session lookup and the owner-token check
  (server.mjs:859), so an unknown action on an unknown session is 404 and on a
  token mismatch is 403.
* the session id is read from the ``X-Amzn-Bedrock-AgentCore-Runtime-Session-Id``
  header FIRST and from body ``runtimeSessionId`` only as a fallback
  (server.mjs:828-830). The owner token is read from the body ALONE -- the real
  worker has no owner-token header (session-guard.mjs ``admitAction``).
* ``start`` on a session that already exists is 409 unconditionally
  (server.mjs:810) -- there is no ``sinceSeq`` resume exemption, so a client
  that lost its live stream resumes with ``attach``, not with a second
  ``start``.

Known deviations from the real worker, and why
----------------------------------------------
* The SSE response sends ``Connection: close`` where the real worker sends
  ``Connection: keep-alive`` and therefore chunked framing. Python's
  ``BaseHTTPRequestHandler`` cannot emit chunked without hand-rolling it, and
  both forms are transparent to a real HTTP client; the framing is the only
  difference, so a socket-level test can read frames without a de-chunker.
* No transcript archiving, no ``SESSION_TTL_MS`` sweep (server.mjs:449-462): a
  finished session stays attachable for the life of the fixture instead of
  disappearing on a timer, which is what makes a test deterministic.
* ``protocol_version`` is accepted for API compatibility but is deliberately
  NOT asserted anywhere, because the real worker asserts no protocol version.
"""

from __future__ import annotations

import contextlib
import json
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Iterator

#: Accepted for API compatibility; never asserted (server.mjs:624-626).
PROTOCOL_VERSION = "2025-08-22"

#: Terminal events are never pruned: a late attach still has to learn the
#: outcome (hub.mjs:28-29).
TERMINAL_EVENT_TYPES = {"done", "error"}

#: Fault switches read off a `start` body, whitelisted exactly as the spike's
#: worker.py:412-415 does. `silentAfterSeq` is new here.
FAULT_KEYS = frozenset(
    {
        "dropAfterSeqs",
        "fatalAfterSeq",
        "slowApprovalMs",
        "maxHistory",
        "silentAfterSeq",
    }
)

ACTIONS = frozenset({"start", "rpc", "attach", "stop"})

#: A missing `action` is a `start` (server.mjs:826).
DEFAULT_ACTION = "start"

#: Real AgentCore contract, asserted against by the tests
#: (server.mjs MIN_SESSION_ID_LENGTH / SID_HEADER).
SESSION_ID_MIN_LEN = 33
SESSION_ID_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"

#: hub.mjs:43 -- `Math.max(16, maxHistory)`.
MIN_HISTORY = 16
DEFAULT_MAX_HISTORY = 5000


def action_result(
    action: str,
    *,
    delivered: bool = False,
    seq: int = 0,
    reason: str | None = None,
) -> dict:
    """The ONE shape every non-streaming answer takes (server.mjs:127-134).

    All four keys are always present, so a client reads fields instead of
    inferring meaning from which fields happen to exist.
    """
    return {
        "action": str(action if action is not None else "unknown"),
        "delivered": bool(delivered),
        "seq": int(seq) if isinstance(seq, (int, float)) else 0,
        "reason": None if reason is None else str(reason),
    }


# ───────────────────────────── hub ─────────────────────────────


class Hub:
    """Per-session fan-out with a bounded, seq-stamped history."""

    def __init__(self, max_history: int = DEFAULT_MAX_HISTORY) -> None:
        self.lock = threading.Lock()
        self.history: list[dict] = []
        self.listeners: set[queue.Queue] = set()
        self.seq = 0
        # hub.mjs:43 -- production cannot honour a cap below 16, so a test that
        # asks for one must not be told it can have it.
        self.max_history = max(MIN_HISTORY, max_history)
        self.pruned_through_seq = 0
        self.pruned_count = 0
        self.closed = False

    def emit(self, event: dict) -> dict:
        with self.lock:
            if self.closed:
                return event
            self.seq += 1
            e = dict(event)
            e["seq"] = self.seq
            e.setdefault("ts", round(time.time(), 6))
            self.history.append(e)
            while len(self.history) > self.max_history:
                idx = next(
                    (
                        i
                        for i, h in enumerate(self.history)
                        if h.get("type") not in TERMINAL_EVENT_TYPES
                    ),
                    -1,
                )
                if idx == -1:
                    break
                dropped = self.history.pop(idx)
                self.pruned_through_seq = max(self.pruned_through_seq, dropped["seq"])
                self.pruned_count += 1
            listeners = list(self.listeners)
        for q in listeners:
            q.put(e)
        return e

    def _replay_into(self, q: queue.Queue, since_seq: int) -> None:
        if self.pruned_through_seq > since_seq:
            q.put(
                {
                    "type": "history_gap",
                    # A restatement of the prune watermark, NOT a fresh seq.
                    "seq": self.pruned_through_seq,
                    "droppedEvents": self.pruned_count,
                    "throughSeq": self.pruned_through_seq,
                    "message": (
                        f"{self.pruned_count} earlier event(s) pruned from the "
                        "worker's bounded history"
                    ),
                }
            )
        for e in self.history:
            if e["seq"] > since_seq:
                q.put(e)

    def subscribe(self, since_seq: int = 0) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self.lock:
            self._replay_into(q, since_seq)
            if not self.closed:
                self.listeners.add(q)
            else:
                q.put(None)
        return q

    def replay_only(self, since_seq: int = 0) -> list[dict]:
        """Replay without registering a listener -- what ``attach`` uses."""
        q: queue.Queue = queue.Queue()
        with self.lock:
            self._replay_into(q, since_seq)
        out = []
        while not q.empty():
            out.append(q.get_nowait())
        return out

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.listeners.discard(q)

    def close(self) -> None:
        with self.lock:
            self.closed = True
            listeners = list(self.listeners)
            self.listeners.clear()
        for q in listeners:
            q.put(None)


# ────────────────────── event derivation (pure) ──────────────────────


def derive_usage(params: dict) -> dict | None:
    """The advisory ``usage`` event, exactly as ``deriveUsage`` derives it.

    ``advisory: true`` is on the wire because the same credits are already
    inside the ``acp`` frame this is derived from -- a client that sums both
    double-counts (server.mjs:390-411).
    """
    metering = params.get("meteringUsage") if isinstance(params, dict) else None
    if not isinstance(metering, list) or not metering:
        return None
    credits = 0.0
    for entry in metering:
        raw = entry.get("value") if isinstance(entry, dict) else entry
        try:
            value = float(raw)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if value != value or value in (float("inf"), float("-inf")):
            continue
        credits += value
    return {
        "type": "usage",
        "advisory": True,
        "credits": round(credits, 6),
        "entries": len(metering),
        "contextUsagePercentage": params.get("contextUsagePercentage"),
    }


def derive_events(msg: dict) -> list[dict]:
    """The worker's ``_onLine`` derivation rules as a pure function.

    ``msg`` is one raw JSON-RPC message from the (fake) child. Returns the
    events it derives, in order and unstamped (server.mjs:305-338):

    * the verbatim ``acp`` carrier, always -- nothing rewrites the payload;
    * ``params.meteringUsage`` -> an advisory ``usage`` event;
    * ``result.stopReason`` -> ``status``/``turn_end`` then terminal ``done``.

    ``result.sessionId`` capture is :func:`derived_acp_session_id` -- it is
    state, not an event.
    """
    out: list[dict] = [{"type": "acp", "payload": msg}]

    usage = derive_usage(msg.get("params") or {})
    if usage is not None:
        out.append(usage)

    result = msg.get("result")
    if isinstance(result, dict) and "stopReason" in result:
        out.append(
            {
                "type": "status",
                "phase": "turn_end",
                "stopReason": result["stopReason"],
            }
        )
        out.append({"type": "done", "stopReason": str(result["stopReason"])})
    return out


def derived_acp_session_id(msg: dict) -> str | None:
    """``session/new`` result -> the ACP session id to remember for cancel."""
    result = msg.get("result")
    if isinstance(result, dict) and result.get("sessionId"):
        return str(result["sessionId"])
    return None


# ───────────────────────────── session ─────────────────────────────


class Session:
    """One AgentCore session: one hub, one canned event script."""

    def __init__(
        self,
        session_id: str,
        owner_token: str,
        opts: dict,
        replies: dict[str, Callable[[dict], list[dict]]] | None = None,
    ) -> None:
        self.session_id = session_id
        self.owner_token = owner_token
        self.opts = opts
        self.hub = Hub(max_history=int(opts.get("maxHistory") or DEFAULT_MAX_HISTORY))
        self.acp_session_id: str | None = None
        self.started = False
        #: a terminal event (`done`, or `error{fatal}`) has been emitted
        self.terminal = False
        #: the session is over: hub closed, script stopped
        self.ended = False
        #: inbound JSON-RPC `method` -> the child's scripted answer
        self.replies: dict[str, Callable[[dict], list[dict]]] = dict(replies or {})
        self.drop_after_seqs = sorted(int(s) for s in (opts.get("dropAfterSeqs") or []))
        self.fatal_after_seq = opts.get("fatalAfterSeq")
        self.slow_approval_ms = int(opts.get("slowApprovalMs") or 0)
        self.silent_after_seq = opts.get("silentAfterSeq")
        self._rpc_gate = threading.Event()
        self._lock = threading.Lock()

    # -- emit path -------------------------------------------------------

    def emit(self, event: dict) -> dict:
        """Emit through the hub, then run the terminal / fatal bookkeeping."""
        e = self.hub.emit(event)
        # server.mjs `isTerminal`: a fatal error is as final as a `done`.
        is_terminal = e.get("type") == "done" or (
            e.get("type") == "error" and e.get("fatal") is True
        )
        if is_terminal:
            self.terminal = True
            self.end()
        else:
            self._maybe_fatal()
        return e

    def _maybe_fatal(self) -> None:
        """`fatalAfterSeq`, evaluated in the EMIT path (spike defect fix)."""
        with self._lock:
            if self.terminal or self.fatal_after_seq is None:
                return
            if self.hub.seq < int(self.fatal_after_seq):
                return
            self.fatal_after_seq = None
            self.terminal = True
        # `failSession` shape (server.mjs:481-486): `code` is always present.
        self.hub.emit(
            {
                "type": "error",
                "fatal": True,
                "code": None,
                "message": "injected fatal worker error",
            }
        )
        # A fatal error is terminal for the SESSION, not just the stream.
        self.end()

    def end(self) -> None:
        """End the session: release a gated script, close the hub."""
        self.ended = True
        self._rpc_gate.set()
        self.hub.close()

    # -- scripted "child" ------------------------------------------------

    def run_script(self, events: list[dict]) -> None:
        self.started = True
        threading.Thread(
            target=self._pump_script,
            args=([dict(e) for e in events],),
            name=f"fake-worker-script-{self.session_id[:8]}",
            daemon=True,
        ).start()

    def _pump_script(self, events: list[dict]) -> None:
        for item in events:
            if self.ended:
                return
            if item.pop("_await_rpc", False) and not self._await_rpc():
                return
            self._emit_scripted(item)

    def _await_rpc(self, timeout: float = 10.0) -> bool:
        """Pause the script until the next SUCCESSFUL rpc delivery."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ended:
                return False
            if self._rpc_gate.wait(0.02):
                self._rpc_gate.clear()
                return not self.ended
        return False

    def _emit_scripted(self, item: dict) -> None:
        payload = item.get("payload")
        if item.get("type") != "acp" or not isinstance(payload, dict):
            self.emit(item)
            return
        sid = derived_acp_session_id(payload)
        if sid:
            self.acp_session_id = sid
        events = derive_events(payload)
        # Keys the script put on the `acp` frame itself win over the carrier.
        events[0] = {**events[0], **item}
        for event in events:
            if self.ended:
                return
            self.emit(event)

    # -- actions ---------------------------------------------------------

    def deliver_rpc(self, message: object) -> dict:
        """Deliver ONE JSON-RPC message; answers ``deliverRpc``'s result.

        Mirrors server.mjs:670-712 exactly. A failed delivery is recorded in the
        sequence space too (``status``/``rpc_dropped`` plus a NON-fatal
        ``error``) -- a silent drop is precisely the case a client must be able
        to detect. ``seq`` is 0 when the hub accepted nothing, so a client can
        never mistake another event's seq for its own delivery.
        """
        if not isinstance(message, dict):
            return action_result("rpc", reason="rpc requires a JSON-RPC `message` object")
        if not self.started:
            return action_result("rpc", reason="the agent child has not been started")
        # `slowApprovalMs` delays only rpc deliveries.
        if self.slow_approval_ms:
            time.sleep(self.slow_approval_ms / 1000.0)

        ok = not self.ended
        reason = None if ok else "the agent child is not accepting input"
        status: dict = {
            "type": "status",
            "phase": "rpc_delivered" if ok else "rpc_dropped",
            "rpcId": message.get("id"),
            "method": (message.get("method") if isinstance(message.get("method"), str) else None),
            "delivered": ok,
        }
        if not ok:
            status["reason"] = reason

        seq_before = self.hub.seq
        self.emit(status)
        seq = self.hub.seq if self.hub.seq > seq_before else 0
        if not ok:
            self.hub.emit(
                {
                    "type": "error",
                    "fatal": False,
                    "message": f"rpc not delivered: {reason}",
                }
            )
            return action_result("rpc", seq=seq, reason=reason)

        self._rpc_gate.set()
        self._emit_reply(message)
        return action_result("rpc", delivered=True, seq=seq)

    def _emit_reply(self, message: dict) -> None:
        """Emit the scripted child answer to this inbound message, if any.

        Emitted on the delivering thread, AFTER the status event, so the
        ``seq`` in the rpc answer still points at the delivery itself and a
        test needs no sleep to observe the reply.
        """
        method = message.get("method")
        reply = self.replies.get(method) if isinstance(method, str) else None
        if reply is None:
            return
        for event in reply(message) or []:
            if self.ended:
                return
            self._emit_scripted(dict(event))

    def stop(self) -> None:
        if self.ended:
            return
        self.emit({"type": "status", "phase": "stopping"})
        if not self.terminal:
            # server.mjs:753 -- the no-child branch of `stopSession`.
            self.emit({"type": "done", "stopReason": "stopped", "exitCode": None})
        self.end()


# ───────────────────────────── HTTP ─────────────────────────────


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def worker(self) -> FakeWorker:
        return self.server.worker  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        """Silence the server (spike: worker.py:344-346 logged every line)."""

    # -- helpers ---------------------------------------------------------

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _open_sse(self, sid: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # The real worker sends `keep-alive` (and therefore chunked framing);
        # see the module docstring for why this one header differs.
        self.send_header("Connection", "close")
        self.send_header(SESSION_ID_HEADER, sid)
        self.end_headers()

    def _sse(self, event: dict) -> None:
        self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
        self.wfile.flush()

    def _keepalive(self) -> None:
        self.wfile.write(b": ping\n\n")
        self.wfile.flush()

    @property
    def _poll_secs(self) -> float:
        return min(0.1, self.worker.keepalive_secs) or 0.1

    # -- routes ----------------------------------------------------------

    def do_GET(self) -> None:
        if self.path in ("/ping", "/ping/"):
            # server.mjs:867-870 -- `sessions` is a COUNT of unfinished ones.
            self._json(
                200,
                {"status": "Healthy", "sessions": len(self.worker.sessions())},
            )
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path not in ("/invocations", "/invocations/"):
            self._json(404, {"error": "Not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, action_result("unknown", reason="invalid JSON payload"))
            return
        if not isinstance(body, dict):
            body = {}

        action = body.get("action")
        if not isinstance(action, str):
            action = DEFAULT_ACTION
        # The AgentCore header wins; the body is only a fallback.
        session_id = (
            self.headers.get(SESSION_ID_HEADER) or str(body.get("runtimeSessionId") or "") or ""
        )
        # The owner token comes from the BODY alone: the real worker reads no
        # owner-token header (session-guard.mjs `admitAction`).
        token = body.get("ownerToken") or ""
        since_seq = int(body.get("sinceSeq") or 0)

        if len(session_id) < SESSION_ID_MIN_LEN:
            self._json(
                400,
                action_result(
                    action,
                    reason=(
                        "missing or too-short session id (need >= "
                        f"{SESSION_ID_MIN_LEN} chars, got {len(session_id)})"
                    ),
                ),
            )
            return

        sess, rejection = self.worker.resolve(body, session_id, token, action)
        if rejection is not None:
            status, reason, seq = rejection
            self._json(status, action_result(action, seq=seq, reason=reason))
            return
        assert sess is not None

        if action == "start":
            self._do_start(sess, session_id, since_seq)
        elif action == "rpc":
            self._do_rpc(sess, body.get("message"))
        elif action == "attach":
            self._do_attach(sess, session_id, since_seq)
        elif action == "stop":
            self._do_stop(sess, session_id)
        else:
            # server.mjs:859 -- checked LAST, after the lookup and the owner
            # check, so an unknown action on an unknown session is 404.
            self._json(400, action_result(action, reason=f'unknown action "{action}"'))

    # -- action handlers -------------------------------------------------

    def _stream(self, sess: Session, sid: str, since_seq: int, allow_drop: bool) -> None:
        q = sess.hub.subscribe(since_seq)
        self._open_sse(sid)
        keepalive = self.worker.keepalive_secs
        last_ka = time.monotonic()
        try:
            while True:
                try:
                    e = q.get(timeout=self._poll_secs)
                except queue.Empty:
                    silent = sess.silent_after_seq
                    if silent is not None and sess.hub.seq >= int(silent):
                        # `silentAfterSeq`: hold the connection open and emit
                        # NOTHING, not even `: ping`.
                        continue
                    if time.monotonic() - last_ka >= keepalive:
                        self._keepalive()
                        last_ka = time.monotonic()
                    continue
                if e is None:
                    return
                self._sse(e)
                if (
                    allow_drop
                    and sess.drop_after_seqs
                    and e.get("seq", 0) >= sess.drop_after_seqs[0]
                ):
                    # Each threshold pops (ported mechanic). In practice only
                    # the first can fire per session: the real worker refuses a
                    # second `start` with 409, so a dropped client re-reads with
                    # `attach` rather than re-opening a live stream.
                    sess.drop_after_seqs.pop(0)
                    return
                if e.get("type") == "done" or (e.get("type") == "error" and e.get("fatal") is True):
                    return
        except (BrokenPipeError, ConnectionResetError):
            pass  # client vanished mid-stream
        finally:
            sess.hub.unsubscribe(q)

    def _do_start(self, sess: Session, sid: str, since_seq: int) -> None:
        # Subscribed BEFORE delivery (server.mjs defect (c)): the launch's own
        # events must reach this response as they happen.
        if not sess.started:
            sess.run_script(self.worker.scripted_events())
        self._stream(sess, sid, since_seq, allow_drop=True)

    def _do_rpc(self, sess: Session, message: object) -> None:
        result = sess.deliver_rpc(message)
        # server.mjs:848 -- a failed delivery is 409, the body is the same shape.
        self._json(200 if result["delivered"] else 409, result)

    def _do_attach(self, sess: Session, sid: str, since_seq: int) -> None:
        events = sess.hub.replay_only(since_seq)
        self._open_sse(sid)
        for e in events:
            self._sse(e)
        # Describes THIS attach, not the session: written to this response only
        # and never hub-stamped, with an explicit null seq (server.mjs:718-722).
        self._sse(
            {
                "type": "attach_end",
                "seq": None,
                "live": not sess.terminal,
                "lastSeq": sess.hub.seq,
            }
        )
        # read-only: replay then END.

    def _do_stop(self, sess: Session, sid: str) -> None:
        q = sess.hub.subscribe(sess.hub.seq)
        self._open_sse(sid)
        threading.Thread(target=sess.stop, name="fake-worker-stop", daemon=True).start()
        keepalive = self.worker.keepalive_secs
        last_ka = time.monotonic()
        deadline = time.monotonic() + 5.0
        try:
            while time.monotonic() < deadline:
                try:
                    e = q.get(timeout=self._poll_secs)
                except queue.Empty:
                    if time.monotonic() - last_ka >= keepalive:
                        self._keepalive()
                        last_ka = time.monotonic()
                    continue
                if e is None:
                    return
                self._sse(e)
                if e.get("type") == "done":
                    return
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            sess.hub.unsubscribe(q)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    worker: FakeWorker


# ───────────────────────────── fixture ─────────────────────────────


class FakeWorker:
    """A fake AgentCore worker on an ephemeral loopback port.

    ``max_history`` / ``maxHistory`` and the other fault switches are instance
    DEFAULTS; a ``start`` body may override any of them per session.
    """

    def __init__(
        self,
        *,
        max_history: int = DEFAULT_MAX_HISTORY,
        keepalive_secs: float = 5.0,
        protocol_version: str = PROTOCOL_VERSION,
        max_sessions: int = 8,
    ) -> None:
        self.defaults: dict[str, Any] = {"maxHistory": int(max_history)}
        self.keepalive_secs = float(keepalive_secs)
        #: Accepted for API compatibility; never asserted, because the real
        #: worker asserts no protocol version anywhere.
        self.protocol_version = protocol_version
        self.max_sessions = int(max_sessions)
        self._script: list[dict] = []
        self._replies: dict[str, Callable[[dict], list[dict]]] = {}
        self._sessions: dict[str, Session] = {}
        self._sessions_lock = threading.Lock()
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle -------------------------------------------------------

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("base_url is only resolved after start()")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> None:
        if self._server is not None:
            return
        server = _Server(("127.0.0.1", 0), _Handler)
        server.worker = self
        self._server = server
        self._thread = threading.Thread(
            target=server.serve_forever, name="fake-agentcore-worker", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        server, self._server = self._server, None
        with self._sessions_lock:
            sessions = list(self._sessions.values())
        for sess in sessions:
            # Release every parked `_stream`, silent ones included.
            sess.end()
        if server is None:
            return
        server.shutdown()
        server.server_close()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=2.0)

    # -- scripting -------------------------------------------------------

    def script(self, events: list[dict]) -> None:
        """Set the canned event source that replaces the real child.

        Each dict is emitted through :meth:`Hub.emit` in order when a session
        starts. A dict of ``type: "acp"`` with a ``payload`` also produces the
        events :func:`derive_events` derives from that payload. A dict carrying
        ``"_await_rpc": True`` pauses emission until the next successful ``rpc``
        delivery -- that is how an approval is scripted.
        """
        self._script = [dict(e) for e in events]

    def scripted_events(self) -> list[dict]:
        return [dict(e) for e in self._script]

    def script_replies(self, replies: dict[str, Callable[[dict], list[dict]]]) -> None:
        """Script the child's ANSWER to an inbound JSON-RPC message.

        The real worker performs no ACP handshake (server.mjs:624-626) -- the
        client drives ``initialize``, ``session/new`` and ``session/prompt``
        through ``rpc`` and the worker forwards them. This maps an inbound
        method name to a callable that receives the delivered message and
        returns the events to emit in answer, normally one ``acp`` event
        carrying ``{"jsonrpc": "2.0", "id": <the inbound id>, "result": {...}}``
        so the reply echoes the caller's real id.

        Emission still goes through :meth:`Hub.emit`, so seqs stay
        authoritative, and an ``acp`` reply is run through
        :func:`derive_events` exactly like a scripted one -- a reply whose
        ``result`` carries ``stopReason`` therefore produces
        ``status``/``turn_end`` and a terminal ``done`` by itself.

        Independent of :meth:`script`: both mechanisms can be used at once.
        """
        self._replies = dict(replies)

    def scripted_replies(self) -> dict[str, Callable[[dict], list[dict]]]:
        return dict(self._replies)

    def sessions(self) -> list[str]:
        """Live session ids."""
        with self._sessions_lock:
            return [sid for sid, s in self._sessions.items() if not s.ended]

    # -- request plumbing ------------------------------------------------

    def resolve(
        self, body: dict, session_id: str, token: str, action: str
    ) -> tuple[Session | None, tuple[int, str, int] | None]:
        """Look up or create the session.

        Returns ``(session, None)`` or ``(None, (status, reason, seq))``,
        mirroring server.mjs:808-846: 409 for a `start` on a session that
        already exists (unconditionally -- there is no ``sinceSeq`` exemption),
        429 at the concurrency cap, 404 for a non-start action on an unknown
        session, 403 on an owner-token mismatch.
        """
        with self._sessions_lock:
            sess = self._sessions.get(session_id)
            if action == "start":
                if sess is not None:
                    return None, (
                        409,
                        f"session {session_id} already started",
                        sess.hub.seq,
                    )
                live = sum(1 for s in self._sessions.values() if not s.ended)
                if live >= self.max_sessions:
                    return None, (
                        429,
                        (
                            "Runtime is at its concurrent-session limit "
                            f"({self.max_sessions} active). Retry when a story "
                            "finishes."
                        ),
                        0,
                    )
                opts = dict(self.defaults)
                opts.update({k: v for k, v in body.items() if k in FAULT_KEYS})
                sess = Session(session_id, token, opts, self.scripted_replies())
                self._sessions[session_id] = sess
                return sess, None
            if sess is None:
                return None, (
                    404,
                    'unknown session; send action "start" first',
                    0,
                )
        if sess.owner_token and token != sess.owner_token:
            return None, (
                403,
                "Not the delegating client for this session (owner token mismatch)",
                0,
            )
        return sess, None


@contextlib.contextmanager
def fake_worker(**kwargs: Any) -> Iterator[FakeWorker]:
    """Start a :class:`FakeWorker` for the body of the ``with`` block."""
    worker = FakeWorker(**kwargs)
    worker.start()
    try:
        yield worker
    finally:
        worker.stop()
