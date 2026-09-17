"""The bridge: one UNIX socket on this side, one AgentCore session on the other.

``AcpClient`` speaks newline-framed JSON-RPC to a child process's stdin and stdout, and
about twenty call sites reach ``self._process.stdin`` directly, so there is no
stream-pair seam inside it to swap a socket into. What IS a seam is the harness, whose
entire output is an argv -- so the remote harness returns the argv of
:mod:`kiro_crew.agentcore.stdio_shim`, a byte relay, and this module is the other end of
the relay's socket::

    AcpClient --pipes--> stdio_shim --UNIX socket--> BRIDGE --HTTPS--> worker --> kiro-cli acp

Everything downstream of session creation is untouched, which is the whole reason a
remote agent renders in the dashboard exactly like a local one.

Facts about the far end that shaped this module, each read off the worker as BUILT
(``packaging/agentcore-worker/server.mjs`` and ``hub.mjs``) rather than off the RFC,
which describes the WP0 spike and disagrees with the container in several places:

* **There is ONE resume path.** ``start`` on a session that already exists answers 409
  unconditionally -- there is no ``sinceSeq`` resume through it. So a dropped live
  stream is never recovered as a live stream: the bridge polls the read-only ``attach``
  action from its watermark until a terminal event or ``attach_end.live == false``. The
  cost is real and worth naming: a turn that drops early is observed at
  ``poll_interval`` granularity for its whole remainder.
* **A failed ``rpc`` answers HTTP 409, not 200 with a flag.** Every non-streaming answer
  is the worker's ``actionResult`` shape ``{action, delivered, seq, reason}``, and an
  undelivered message is the case this bridge must detect rather than assume -- an
  approval fired into a child that has already exited is exactly the race after a drop.
  An unparsable or missing answer counts as NOT delivered and is re-sent after the next
  re-attach, which is safe because a JSON-RPC id is idempotent at the child.
* **Deduplication is the CLIENT's obligation.** Several invokes may be open on one
  session at once -- a live stream, a poll, a stop -- and each delivers from its own
  ``sinceSeq``. The worker guarantees monotonicity and gap announcement, not single
  delivery, so the watermark here is what keeps the transcript clean.
* **``usage`` is advisory and must never be summed.** The same credits already arrive
  inside the ``acp`` frame it is derived from, so accumulating both double-bills the
  operator -- a UI-visible defect.
* **``attach_end`` carries no sequence number** and must not advance the watermark: it
  describes THIS attach, not the session, so stamping it would push every other
  client's watermark past an event it never received.

Two things this module deliberately does not do. It never reads a credential file: the
profile it signs with is resolved through :mod:`kiro_crew.aws_consent`, which re-verifies
the account live because a profile NAME is not an account. And it imports the AWS SDK
INSIDE the method that needs it, so a public install without the ``agentcore`` extra
never imports boto3 at all -- a module-level import would fail that boundary, which
``test_agentcore_bridge.py`` pins in a subprocess.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import secrets
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Protocol

from kiro_crew.acp.harness.agentcore import RECONNECT_POLL_INTERVAL_MS
from kiro_crew.agentcore.liveness import RemoteLiveness
from kiro_crew.agentcore.sse import SseMalformedEvent, iter_sse_events

logger = logging.getLogger(__name__)

__all__ = [
    "ActionResult",
    "AgentCoreBridge",
    "BridgeOutcome",
    "BridgeUnconfigured",
    "RuntimeCoordinates",
    "Transport",
    "WorkerRejected",
    "agentcore_runtime_path",
    "load_runtime_coordinates",
    "mint_owner_token",
    "mint_session_id",
    "prepare_remote_session",
    "socket_path_for",
]

#: The platform's own floor, enforced by the worker so a short id fails loudly.
SESSION_ID_MIN_LENGTH = 33

#: How long to keep dialling the shim's socket before giving up.
#:
#: The SHIM binds and listens; this side dials. That order is deliberate -- the shim owns
#: the node's permissions (it binds under ``umask(0o077)``) and closes its listener after
#: exactly one accept -- but it means the socket does not exist until ``AcpClient`` has
#: actually spawned the relay, which is a process start this module does not await. So a
#: dial that fails with ENOENT or ECONNREFUSED is expected for the first few attempts and
#: is retried; anything past this budget is a spawn that never happened.
DIAL_TIMEOUT_SECS = 20.0

#: Gap between dial attempts. Short because the whole wait is normally one process start.
DIAL_RETRY_SECS = 0.05

#: Terminal event types: the two things that end a session rather than a stream.
TERMINAL_EVENT_TYPES = frozenset({"done", "error"})

#: Conservative ceiling for a UNIX socket path, in bytes.
#:
#: ``sockaddr_un.sun_path`` is 104 bytes on macOS and 108 on Linux, INCLUDING the
#: terminating NUL, and a path over it fails at bind with an error that names neither the
#: limit nor the offending path. 100 leaves room for both platforms and for the ``.sock``
#: suffix rather than encoding the tighter of the two as if it were the rule.
SOCKET_PATH_MAX_BYTES = 100

#: How much of the session id the socket filename carries.
#:
#: A slug, not the whole id: the full id is 41 characters and the path budget above is
#: 100 for everything including the crew home. Sixteen hex characters of an id minted
#: from ``secrets`` is ~64 bits of entropy scoped to one directory, so a collision is not
#: a risk worth a longer name; the FULL id still travels in every action's envelope,
#: which is what the worker matches on.
SOCKET_NAME_SLUG_LENGTH = 16


class BridgeError(Exception):
    """Base for every failure this module raises."""


class BridgeUnconfigured(BridgeError):
    """No runtime coordinates on the keystone, so there is nothing to invoke.

    Its own type because the remedy is an operator action -- provisioning a runtime and
    writing the leaf -- and not a retry. Fail-closed on purpose: an absent leaf must not
    resolve to a default runtime, which would invoke SOMETHING in an account nobody named.
    """


class ShimHandshakeFailed(BridgeError):
    """The relay's socket never accepted a connection, or refused the owner token."""


class WorkerRejected(BridgeError):
    """The worker refused an action with an HTTP status and a reason.

    Carries the status because the four the worker uses are four different situations:
    403 a token mismatch, 404 an unknown session, 409 a session-state conflict or an
    undelivered message, 429 the concurrency cap. A caller that lumped them together
    would retry the one case that can never succeed.
    """

    def __init__(self, status: int, action: str, reason: str) -> None:
        super().__init__(f"worker refused {action!r} with HTTP {status}: {reason}")
        self.status = status
        self.action = action
        self.reason = reason


@dataclass(frozen=True)
class RuntimeCoordinates:
    """Where the remote agent runs. Trust-root data, read from the keystone leaf."""

    runtime_arn: str
    region: str
    endpoint_name: str = "DEFAULT"
    profile: str = ""


@dataclass(frozen=True)
class ActionResult:
    """The worker's ``actionResult`` shape, the answer to every non-streaming action."""

    action: str
    delivered: bool
    seq: int
    reason: str | None = None

    @classmethod
    def parse(cls, action: str, payload: object) -> "ActionResult":
        """Read a worker answer, treating anything unrecognisable as NOT delivered.

        The pessimistic default is the contract: a bridge that read a missing or garbled
        answer as success would drop an approval silently, and the only safe reading of
        "I do not know whether this arrived" is to re-send after re-attaching.
        """
        if not isinstance(payload, dict):
            return cls(action, False, 0, "worker answer was not a JSON object")
        raw_seq = payload.get("seq")
        seq = raw_seq if isinstance(raw_seq, int) and not isinstance(raw_seq, bool) else 0
        reason = payload.get("reason")
        return cls(
            action=str(payload.get("action") or action),
            delivered=bool(payload.get("delivered")),
            seq=seq,
            reason=str(reason) if reason is not None else None,
        )


@dataclass
class BridgeOutcome:
    """What one remote session did, for the caller's status line and the ledger."""

    stop_reason: str = ""
    exit_code: int | None = None
    last_seq: int = 0
    credits: float = 0.0
    reconnects: int = 0
    duplicates_suppressed: int = 0
    history_gaps: int = 0
    undelivered: int = 0
    fatal_message: str = ""

    @property
    def ok(self) -> bool:
        """True when the session ended by finishing a turn rather than by failing."""
        return self.stop_reason not in {"", "fatal", "session_gone"}


class Transport(Protocol):
    """How an action reaches the worker. One method per answer SHAPE, not per action.

    A protocol rather than a concrete client because the two implementations are
    genuinely different transports -- ``InvokeAgentRuntime`` over SigV4 in production,
    plain HTTP against an in-process fake in the tests -- and because keeping the AWS
    call behind it is what lets every behaviour in this module be asserted without a
    network, a credential or an account.
    """

    def invoke_stream(self, body: dict[str, Any]) -> AsyncIterator[bytes]:
        """Open a streaming action (``start``, ``attach``, ``stop``) and yield raw bytes."""
        ...  # pragma: no cover - protocol

    async def invoke_json(self, body: dict[str, Any]) -> tuple[int, object]:
        """Send a non-streaming action (``rpc``) and return ``(status, decoded body)``."""
        ...  # pragma: no cover - protocol

    async def stop_session(self, session_id: str) -> None:
        """Ask the PLATFORM to end the microVM session -- the last rung of the ladder."""
        ...  # pragma: no cover - protocol


def agentcore_runtime_path() -> Path:
    """Return the path to ``agentcore_runtime.json`` -- the runtime coordinates leaf.

    Same KEYSTONE reasoning as ``computer_use_state_path``: the leaf is ``READONLY`` in
    every sandbox mode because a writable one would let a prompt-injected agent name the
    runtime its next delegation executes on, in an account the operator never consented
    to, reached with the gateway's own signing identity. It is deliberately not HIDDEN --
    a reader finding it absent resolves to "no remote runtime configured", so masking it
    would make a provisioned runtime read as unconfigured while concealing nothing
    secret. Respects ``KIROCREW_HOME``.
    """
    from kiro_crew.config.loader import config_dir

    return config_dir() / "agentcore_runtime.json"


def load_runtime_coordinates(path: Path | None = None) -> RuntimeCoordinates:
    """Read the keystone leaf, or refuse.

    Fails CLOSED in all three bad cases -- absent, unreadable, or missing either
    required field -- because the alternative is invoking an unnamed runtime. The two
    optional fields have defaults that are facts rather than guesses: AgentCore
    provisions the ``DEFAULT`` endpoint itself, and an empty profile means the ambient
    credential chain.
    """
    leaf = path if path is not None else agentcore_runtime_path()
    try:
        raw = json.loads(leaf.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BridgeUnconfigured(
            f"no remote runtime is configured: {leaf} does not exist. Provisioning the "
            "runtime and writing this leaf is a human action Crew does not perform."
        ) from exc
    except (OSError, ValueError) as exc:
        raise BridgeUnconfigured(f"{leaf} could not be read as JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise BridgeUnconfigured(f"{leaf} does not hold a JSON object")
    arn = str(raw.get("runtime_arn") or "")
    region = str(raw.get("region") or "")
    missing = [name for name, value in (("runtime_arn", arn), ("region", region)) if not value]
    if missing:
        raise BridgeUnconfigured(f"{leaf} is missing {', '.join(missing)}")
    return RuntimeCoordinates(
        runtime_arn=arn,
        region=region,
        endpoint_name=str(raw.get("endpoint_name") or "DEFAULT"),
        profile=str(raw.get("profile") or ""),
    )


def mint_session_id() -> str:
    """A runtime session id at or above the platform's 33-character floor."""
    return f"kirocrew-{secrets.token_hex(16)}"


def mint_owner_token() -> str:
    """The per-session secret the shim compares against with ``compare_digest``.

    Minted HERE and nowhere else. The shim reads it from its environment and never from
    argv, and the harness deliberately does not re-export it from any other source: the
    value the relay compares against must be the one this bridge minted for this
    session, and a second writer is a second place it can be wrong.
    """
    return secrets.token_urlsafe(32)


def socket_path_for(session_id: str, *, root: Path) -> Path:
    """The relay's socket path for *session_id*, inside a private directory.

    The bridge chooses the path rather than deriving it from a convention, because a
    convention is how two processes come to agree by coincidence; the harness reads this
    exact value out of the spawn environment. ``root`` is created 0700 if absent: the
    node itself is bound under the shim's own ``umask(0o077)``, and a private parent
    means an unrelated process cannot even see the name.

    The FILENAME is a short slug of the session id rather than the whole thing, and the
    total length is checked here, because ``AF_UNIX`` caps a path at 104 bytes on macOS
    and 108 on Linux -- a limit low enough that a full 41-character session id under a
    deep ``KIROCREW_HOME`` overruns it. Overrunning it raises ``OSError: AF_UNIX path too
    long`` from deep inside asyncio at spawn time, which names neither the cause nor the
    fix, so the refusal is raised here with both.
    """
    root.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        root.chmod(stat.S_IRWXU)
    path = root / f"{session_id[-SOCKET_NAME_SLUG_LENGTH:]}.sock"
    if len(str(path).encode("utf-8")) > SOCKET_PATH_MAX_BYTES:
        raise ValueError(
            f"the relay socket path would be {len(str(path))} bytes, over the "
            f"{SOCKET_PATH_MAX_BYTES}-byte AF_UNIX limit: {path}. Point KIROCREW_HOME at a "
            "shorter path, or pass a shorter socket root."
        )
    return path


class AgentCoreBridge:
    """Drives one remote session: dial the relay, pump both ways, resume, stop.

    One instance per session. Holds the watermark, so it is also the thing that makes
    duplicate suppression possible -- see the module docstring on why that is the
    client's job.
    """

    def __init__(
        self,
        transport: Transport,
        *,
        session_id: str,
        owner_token: str,
        socket_path: Path,
        poll_interval_ms: int = RECONNECT_POLL_INTERVAL_MS,
        clock: Callable[[], float] | None = None,
        dial_timeout_secs: float = DIAL_TIMEOUT_SECS,
        watermark_sink: Callable[[int], None] | None = None,
    ) -> None:
        if len(session_id) < SESSION_ID_MIN_LENGTH:
            raise ValueError(
                f"runtimeSessionId must be at least {SESSION_ID_MIN_LENGTH} characters; "
                f"the worker answers 400 below that (got {len(session_id)})"
            )
        self._transport = transport
        self._session_id = session_id
        self._owner_token = owner_token
        self._socket_path = socket_path
        self._poll_interval = poll_interval_ms / 1000.0
        # monotonic rather than the loop's clock: this is called from __init__, before
        # any loop is running, and it measures elapsed silence rather than scheduling.
        self._clock = clock or time.monotonic
        self._dial_timeout = dial_timeout_secs
        # Where the watermark goes so a RESTART can attach from it rather than replaying
        # a whole transcript and re-delivering every approval. A callback rather than a
        # persistence import: a bridge does not know which subagent id it serves -- the
        # run path does -- and giving this module a durable-store dependency would make
        # every test of it need one.
        self._watermark_sink = watermark_sink

        self._watermark = 0
        self._acp_session_id = ""
        self._outcome = BridgeOutcome()
        self._undelivered: list[dict[str, Any]] = []
        self._writer: asyncio.StreamWriter | None = None
        self._stopping = False
        self._liveness = RemoteLiveness(session_id=session_id, started_at=self._clock())

    # ── what the spawn needs ──

    @property
    def spawn_env(self) -> dict[str, str]:
        """The two coordinates the harness reads off the spawn's own environment."""
        from kiro_crew.acp.harness.agentcore import SOCKET_PATH_ENV
        from kiro_crew.agentcore.stdio_shim import OWNER_TOKEN_ENV

        return {SOCKET_PATH_ENV: str(self._socket_path), OWNER_TOKEN_ENV: self._owner_token}

    @property
    def liveness(self) -> RemoteLiveness:
        """The verdict source for a run with no local pid."""
        return self._liveness

    @property
    def outcome(self) -> BridgeOutcome:
        """Counters and the terminal reason, readable while the session is still live."""
        return self._outcome

    # ── the whole session ──

    async def run(self, start_body: dict[str, Any]) -> BridgeOutcome:
        """Serve one session end to end and return how it finished.

        *start_body* carries the worker's own start arguments -- ``cwd``, ``prompt``,
        ``repoNwo`` and the injection switches the tests use. The envelope fields
        (``action``, ``runtimeSessionId``, ``ownerToken``, ``sinceSeq``) are this
        method's to set, so a caller cannot accidentally address another session.
        """
        reader, writer = await self._dial()
        self._writer = writer
        pump = asyncio.create_task(self._pump_to_worker(reader), name="agentcore-bridge-rpc")
        try:
            await self._consume(start_body)
        finally:
            pump.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pump
            # Closing this socket is what ends the turn: the shim returns on socket EOF,
            # its process exits, and AcpClient sees its child go -- the same shape as a
            # local agent finishing.
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()
            with contextlib.suppress(OSError):
                os.unlink(self._socket_path)
        return self._outcome

    async def _dial(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """Connect to the relay and present the owner token as the first line."""
        deadline = self._clock() + self._dial_timeout
        last: OSError | None = None
        while True:
            try:
                reader, writer = await asyncio.open_unix_connection(str(self._socket_path))
                break
            except (FileNotFoundError, ConnectionRefusedError, OSError) as exc:
                last = exc
                if self._clock() >= deadline:
                    raise ShimHandshakeFailed(
                        f"the relay never listened on {self._socket_path} within "
                        f"{self._dial_timeout:.0f}s: {last}"
                    ) from last
                await asyncio.sleep(DIAL_RETRY_SECS)
        # One newline-terminated line, then opaque bytes. The shim consumes the newline
        # and relays nothing of it, so the agent child never sees the token.
        writer.write(f"{self._owner_token}\n".encode("utf-8"))
        await writer.drain()
        return reader, writer

    async def _consume(self, start_body: dict[str, Any]) -> None:
        """The live stream, then -- if it drops -- the one resume path there is."""
        body = {**start_body, **self._envelope("start"), "sinceSeq": self._watermark}
        terminal = await self._drain(self._transport.invoke_stream(body))
        while terminal is None and not self._stopping:
            self._outcome.reconnects += 1
            logger.info(
                "agentcore session %s: stream dropped at seq %d, polling attach every %.0fs",
                self._session_id,
                self._watermark,
                self._poll_interval,
            )
            terminal = await self._poll_until_terminal()

    async def _poll_until_terminal(self) -> str | None:
        """Re-attach on the interval until the session ends or reports itself over."""
        while not self._stopping:
            await asyncio.sleep(self._poll_interval)
            await self._flush_undelivered()
            body = {**self._envelope("attach"), "sinceSeq": self._watermark}
            attach_live: bool | None = None

            def note_attach_end(live: bool) -> None:
                nonlocal attach_live
                attach_live = live

            terminal = await self._drain(
                self._transport.invoke_stream(body), on_attach_end=note_attach_end
            )
            if terminal is not None:
                return terminal
            if attach_live is False:
                # The session is over and its terminal event was pruned, or never
                # reached us. Polling a dead session forever is the failure this
                # sentinel exists to prevent.
                self._outcome.stop_reason = "session_gone"
                return "session_gone"
        return None

    async def _drain(
        self,
        stream: AsyncIterator[bytes],
        *,
        on_attach_end: Callable[[bool], None] | None = None,
    ) -> str | None:
        """Consume one stream. Returns the terminal reason, or None for a DROP.

        A stream that ends or throws without a terminal event is a transport drop, not a
        dead agent -- that distinction is the reason nothing here tunes a timeout.
        """
        try:
            async for event in iter_sse_events(stream):
                self._liveness.note_traffic(self._clock(), seq=_event_seq(event))
                kind = str(event.get("type") or "")
                if kind == "attach_end" or event.get("phase") == "attach_end":
                    # No sequence number, by design: it describes this attach, so the
                    # watermark must NOT move.
                    if on_attach_end is not None:
                        on_attach_end(bool(event.get("live")))
                    continue
                terminal = await self._apply(event, kind)
                if terminal is not None:
                    return terminal
        except SseMalformedEvent as exc:
            # Recoverable rather than fatal: attach replays from the watermark, so the
            # garbled frame and everything after it comes back.
            logger.warning(
                "agentcore session %s: malformed frame, treating as a drop: %r",
                self._session_id,
                exc.raw[:200],
            )
            return None
        except (OSError, asyncio.IncompleteReadError) as exc:
            logger.info("agentcore session %s: stream ended (%s)", self._session_id, exc)
            return None
        return None

    async def _apply(self, event: dict[str, Any], kind: str) -> str | None:
        """Handle one event. Returns a terminal reason when the session is over."""
        if kind == "history_gap":
            through = _event_int(event, "throughSeq")
            # MUST advance, or the same gap is re-reported on every subsequent poll.
            if through > self._watermark:
                self._watermark = through
                self._note_watermark(through)
            self._outcome.history_gaps += 1
            logger.info(
                "agentcore session %s: %d event(s) pruned through seq %d",
                self._session_id,
                _event_int(event, "droppedEvents"),
                through,
            )
            return None

        seq = _event_seq(event)
        if seq is not None and seq <= self._watermark:
            self._outcome.duplicates_suppressed += 1
            return None
        if seq is not None:
            self._watermark = seq
            self._outcome.last_seq = seq
            self._note_watermark(seq)

        if kind == "acp":
            await self._to_agent(event.get("payload"))
            return None
        if kind == "usage":
            # Advisory ONLY. The same credits already arrived inside the acp frame this
            # was derived from, so summing both double-bills the operator.
            return None
        if kind == "status":
            phase = str(event.get("phase") or "")
            if phase == "session_ready":
                self._acp_session_id = str(event.get("sessionId") or self._acp_session_id)
            return None
        if kind == "error":
            if bool(event.get("fatal")):
                self._outcome.stop_reason = "fatal"
                self._outcome.fatal_message = str(event.get("message") or "")
                return "fatal"
            logger.warning(
                "agentcore session %s: non-fatal worker error: %s",
                self._session_id,
                event.get("message"),
            )
            return None
        if kind == "done":
            self._outcome.stop_reason = str(event.get("stopReason") or "done")
            raw_exit = event.get("exitCode")
            self._outcome.exit_code = raw_exit if isinstance(raw_exit, int) else None
            return self._outcome.stop_reason
        return None

    def _note_watermark(self, seq: int) -> None:
        """Hand the advanced watermark to the sink, if any. Never raises into the stream.

        A durable write that failed must not kill a live session: the cost of a lost
        watermark is a replay on the next restart, and the cost of raising here is the
        turn.
        """
        if self._watermark_sink is None:
            return
        try:
            self._watermark_sink(seq)
        except Exception:
            logger.debug("agentcore: watermark sink failed at seq %d", seq, exc_info=True)

    async def _to_agent(self, payload: object) -> None:
        """Write one raw JSON-RPC message into the relay, newline-framed."""
        if payload is None or self._writer is None:
            return
        line = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        self._writer.write(f"{line}\n".encode("utf-8"))
        with contextlib.suppress(Exception):
            await self._writer.drain()

    # ── the other direction ──

    async def _pump_to_worker(self, reader: asyncio.StreamReader) -> None:
        """Read newline-framed JSON-RPC from the relay and deliver each to the child."""
        while True:
            line = await reader.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except ValueError:
                logger.warning(
                    "agentcore session %s: unparsable JSON-RPC from the relay, dropped",
                    self._session_id,
                )
                continue
            if isinstance(message, dict):
                await self._deliver(message)

    async def _deliver(self, message: dict[str, Any]) -> None:
        """One ``rpc`` action, queueing the message for re-send if it did not land."""
        body = {**self._envelope("rpc"), "message": message}
        try:
            status, payload = await self._transport.invoke_json(body)
        except Exception as exc:  # transport failure is indistinguishable from a drop
            logger.info("agentcore session %s: rpc transport error: %s", self._session_id, exc)
            self._queue_undelivered(message)
            return
        result = ActionResult.parse("rpc", payload)
        if status == 200 and result.delivered:
            return
        if status in {403, 404, 429}:
            # Not a delivery problem and not survivable by re-sending.
            raise WorkerRejected(status, "rpc", result.reason or "")
        logger.info(
            "agentcore session %s: rpc not delivered (HTTP %d, %s), queued for re-send",
            self._session_id,
            status,
            result.reason,
        )
        self._queue_undelivered(message)

    def _queue_undelivered(self, message: dict[str, Any]) -> None:
        self._undelivered.append(message)
        self._outcome.undelivered = len(self._undelivered)

    async def _flush_undelivered(self) -> None:
        """Re-send what did not land, after a re-attach. Idempotent at the child."""
        if not self._undelivered:
            return
        pending, self._undelivered = self._undelivered, []
        self._outcome.undelivered = 0
        for message in pending:
            await self._deliver(message)

    # ── stopping ──

    async def stop(self) -> None:
        """The escalation ladder, in order, each rung only if the last did not finish.

        Cooperative first because a cancelled turn still writes its transcript; the
        platform's own session stop is last because it reclaims the container without
        the agent ever knowing, which loses whatever it had not yet emitted.
        """
        self._stopping = True
        if self._acp_session_id:
            with contextlib.suppress(Exception):
                await self._deliver(
                    {
                        "jsonrpc": "2.0",
                        "id": f"bridge-cancel-{secrets.token_hex(4)}",
                        "method": "session/cancel",
                        "params": {"sessionId": self._acp_session_id},
                    }
                )
        with contextlib.suppress(Exception):
            await self._drain(self._transport.invoke_stream(self._envelope("stop")))
        if not self._outcome.stop_reason:
            with contextlib.suppress(Exception):
                await self._transport.stop_session(self._session_id)
            self._outcome.stop_reason = self._outcome.stop_reason or "stopped"

    # ── helpers ──

    def _envelope(self, action: str) -> dict[str, Any]:
        """The four fields every action carries, and no caller gets to set."""
        return {
            "action": action,
            "runtimeSessionId": self._session_id,
            "ownerToken": self._owner_token,
        }


def _event_seq(event: dict[str, Any]) -> int | None:
    """An event's sequence number, or None when it carries none (``attach_end``)."""
    raw = event.get("seq")
    if isinstance(raw, bool) or not isinstance(raw, int):
        return None
    return raw


def _event_int(event: dict[str, Any], key: str) -> int:
    raw = event.get(key)
    return raw if isinstance(raw, int) and not isinstance(raw, bool) else 0


class AgentCoreTransport:
    """The production transport: ``InvokeAgentRuntime`` over SigV4.

    Every AWS import lives inside a method. That is not style -- a module-level boto3
    import would be executed by any install that merely has this file on disk, and the
    ``agentcore`` extra is what puts boto3 there. ``test_agentcore_bridge.py`` asserts
    the boundary by importing this module in a subprocess with boto3 blocked.
    """

    def __init__(self, coordinates: RuntimeCoordinates, *, service: str = "agentcore") -> None:
        self._coordinates = coordinates
        self._service = service
        self._client: Any = None

    async def _authorized_client(self) -> Any:
        """A signed client, but only after the human's consent has been re-verified."""
        if self._client is not None:
            return self._client
        from kiro_crew.aws_consent import authorize

        ok, detail = await authorize(
            self._service,
            profile=self._coordinates.profile,
            region=self._coordinates.region,
        )
        if not ok:
            raise BridgeUnconfigured(f"remote execution is not authorized: {detail}")
        import boto3

        session = boto3.Session(
            profile_name=self._coordinates.profile or None,
            region_name=self._coordinates.region,
        )
        self._client = session.client("bedrock-agentcore")
        return self._client

    async def invoke_stream(self, body: dict[str, Any]) -> AsyncIterator[bytes]:
        """Open a streaming invoke and yield its chunks as they arrive."""
        client = await self._authorized_client()
        response = await asyncio.to_thread(
            client.invoke_agent_runtime,
            agentRuntimeArn=self._coordinates.runtime_arn,
            qualifier=self._coordinates.endpoint_name,
            runtimeSessionId=str(body.get("runtimeSessionId") or ""),
            contentType="application/json",
            accept="text/event-stream",
            payload=json.dumps(body).encode("utf-8"),
        )
        stream = response.get("response")
        if stream is None:
            return
        while True:
            chunk = await asyncio.to_thread(stream.read, 4096)
            if not chunk:
                return
            yield chunk

    async def invoke_json(self, body: dict[str, Any]) -> tuple[int, object]:
        """Send a non-streaming action and decode its one-object answer."""
        client = await self._authorized_client()
        response = await asyncio.to_thread(
            client.invoke_agent_runtime,
            agentRuntimeArn=self._coordinates.runtime_arn,
            qualifier=self._coordinates.endpoint_name,
            runtimeSessionId=str(body.get("runtimeSessionId") or ""),
            contentType="application/json",
            accept="application/json",
            payload=json.dumps(body).encode("utf-8"),
        )
        status = int(response.get("statusCode") or 200)
        stream = response.get("response")
        raw = await asyncio.to_thread(stream.read) if stream is not None else b""
        try:
            return status, json.loads(raw.decode("utf-8") or "null")
        except ValueError:
            return status, None

    async def stop_session(self, session_id: str) -> None:
        """Ask the platform to end the microVM session."""
        client = await self._authorized_client()
        await asyncio.to_thread(
            client.stop_runtime_session,
            agentRuntimeArn=self._coordinates.runtime_arn,
            qualifier=self._coordinates.endpoint_name,
            runtimeSessionId=session_id,
        )


def prepare_remote_session(
    *,
    socket_root: Path | None = None,
    coordinates: RuntimeCoordinates | None = None,
    transport: Transport | None = None,
    poll_interval_ms: int = RECONNECT_POLL_INTERVAL_MS,
) -> AgentCoreBridge:
    """Mint one remote session's coordinates and return its bridge, NOT started.

    Construction and running are separate on purpose. The bridge's
    :attr:`AgentCoreBridge.spawn_env` has to be in the agent child's environment
    BEFORE the harness reads it -- the harness refuses a spawn whose two coordinates are
    absent -- and that environment is assembled synchronously, at provider construction,
    where there is no event loop to run anything on. So the caller builds the bridge
    here, merges ``spawn_env`` into the child env, and starts :meth:`AgentCoreBridge.run`
    from its own async lifecycle once there is a loop.

    Fails CLOSED on an absent or incomplete keystone leaf, by raising
    :class:`BridgeUnconfigured` out of :func:`load_runtime_coordinates`: a session that
    cannot name its runtime must not fall back to one nobody chose.

    *transport* exists for one purpose: an end-to-end test drives the whole path -- a
    real shim subprocess, this bridge, a scripted worker -- and the only piece it cannot
    have is the AWS call. Supplying one skips the keystone read too, because coordinates
    are the argument the production transport needs and nothing else here reads them.
    """
    from kiro_crew.config.loader import config_dir

    if transport is None:
        coords = coordinates if coordinates is not None else load_runtime_coordinates()
        transport = AgentCoreTransport(coords)
    root = socket_root if socket_root is not None else config_dir() / "agentcore-sockets"
    session_id = mint_session_id()
    return AgentCoreBridge(
        transport,
        session_id=session_id,
        owner_token=mint_owner_token(),
        socket_path=socket_path_for(session_id, root=root),
        poll_interval_ms=poll_interval_ms,
    )
