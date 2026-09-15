"""Liveness for an agent with no local process.

Every liveness signal Crew has locally comes from a process id: :mod:`kiro_crew.acp.liveness`
samples a pid's CPU to tell a model call that is thinking from one that has wedged, and
the watchdogs act on the verdict it returns. A remote agent has no such pid, and the
temptation is to supply the one that does exist -- the stdio shim's. That would be
wrong twice over. The shim is a byte relay, so its CPU is flat while the agent is at
its busiest, which reads as wedged; and it is alive for as long as the socket is open,
so it reads as healthy after the container is gone. A pid-shaped answer here is not an
approximation of remote liveness, it is a different question.

So this module answers the question the transport can actually answer. The worker emits
a ``: ping`` comment every :data:`WORKER_KEEPALIVE_MS` and an event whenever the agent
does anything, which makes silence -- not idleness -- the observable:

* traffic within the grace window                -> ``working``
* nothing yet, inside the startup allowance      -> ``unknown``
* silence past the grace window                  -> ``dead``

``unknown`` rather than ``dead`` before the first frame is deliberate: a cold container
pulls an image, clones a repository and drops privileges before it can emit anything,
and a verdict of dead there would reap a session that is merely starting. The oracle
Crew already ships makes the same choice for a missing pid -- ``check_model_wait(None)``
returns ``(VERDICT_UNKNOWN, "no runtime pid")`` rather than DEAD, which is why this
module needs no changes there and no new mechanism: it reports ``(None, None)`` from
:meth:`RemoteLiveness.runtime_info` and the existing code already does the right thing.
A remote session then never appears in ``runtime_pids()``, because the companion-row
builder skips a row whose pid is None -- also already true, also not a change.

Session sharing is refused here for the third time, and that is not redundancy. The
backend id is absent from ``ACP_BACKENDS_SESSION_SHARING`` (a shared runtime would
bypass the provider factory where the one backend-selection gate lives), the spawn
forces the dedicated arm for any ``info.executor``, and :attr:`RemoteLiveness.shares_session`
is False so a caller holding only this object cannot reach a different answer. Each of
the three covers a path the other two do not.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from kiro_crew.acp.liveness import VERDICT_DEAD, VERDICT_UNKNOWN, VERDICT_WORKING

__all__ = [
    "DEAD_AFTER_MISSED_KEEPALIVES",
    "REMOTE_IDENTIFIER_SCHEME",
    "WORKER_KEEPALIVE_MS",
    "RemoteLiveness",
]

#: The worker's own comment-keepalive interval, mirrored from its ``KEEPALIVE_MS``.
#:
#: Mirrored rather than negotiated: the worker sends it, the bridge waits for it, and a
#: constant on each side is the only arrangement that needs no handshake. If the
#: container's ``WORKER_KEEPALIVE_MS`` is ever raised, this must be raised with it --
#: which is why the grace window below is a MULTIPLE rather than a second constant, so
#: only one number has to move.
WORKER_KEEPALIVE_MS = 15_000

#: How many keepalives may be missed before silence counts as death.
#:
#: Three, because one missed ping is a scheduling hiccup and two is a slow network, and
#: because the cost of being wrong differs by direction: declaring a live agent dead
#: destroys work, while waiting one more interval on a dead one costs 15 seconds. The
#: watchdogs this feeds are non-lethal anyway -- they cancel a session, they do not kill
#: a container -- so the conservative side is cheap.
DEAD_AFTER_MISSED_KEEPALIVES = 3

#: Prefix for the identifier that stands where a pid would be in a diagnostic.
#:
#: A scheme rather than a bare id so a reader of a log line can tell at a glance that
#: the thing named is not on this machine, and so a grep for a pid pattern cannot match
#: it by accident.
REMOTE_IDENTIFIER_SCHEME = "agentcore"


@dataclass
class RemoteLiveness:
    """Verdicts for one remote session, derived from stream traffic alone.

    Fed by the bridge on every frame it reads -- events and keepalives alike, because
    the question is whether the far end is still there and a keepalive answers that as
    well as an event does. Holds no clock of its own: the caller passes ``now``, so the
    tests need no sleeping and no monkeypatching.
    """

    session_id: str
    started_at: float
    startup_allowance_secs: float = float(WORKER_KEEPALIVE_MS * 2) / 1000.0
    grace_secs: float = float(WORKER_KEEPALIVE_MS * DEAD_AFTER_MISSED_KEEPALIVES) / 1000.0
    last_traffic_at: float | None = field(default=None)
    last_event_seq: int = 0

    def note_traffic(self, now: float, *, seq: int | None = None) -> None:
        """Record that something arrived from the worker at *now*.

        ``seq`` is carried only so the evidence string can name the last event the
        bridge rendered; a keepalive passes None and still counts as traffic. The
        distinction matters to a human reading a status line and not at all to the
        verdict.
        """
        self.last_traffic_at = now
        if seq is not None and seq > self.last_event_seq:
            self.last_event_seq = seq

    def check(self, now: float) -> tuple[str, str]:
        """``(verdict, evidence)`` in the vocabulary the existing watchdogs consume."""
        if self.last_traffic_at is None:
            waited = now - self.started_at
            if waited <= self.startup_allowance_secs:
                return (
                    VERDICT_UNKNOWN,
                    f"no frame yet from {self.identifier} after {waited:.0f}s, "
                    f"within the {self.startup_allowance_secs:.0f}s startup allowance",
                )
            return (
                VERDICT_DEAD,
                f"{self.identifier} emitted nothing in {waited:.0f}s, past the "
                f"{self.startup_allowance_secs:.0f}s startup allowance",
            )
        quiet = now - self.last_traffic_at
        if quiet <= self.grace_secs:
            return (
                VERDICT_WORKING,
                f"{self.identifier} last spoke {quiet:.0f}s ago at seq {self.last_event_seq}",
            )
        return (
            VERDICT_DEAD,
            f"{self.identifier} silent for {quiet:.0f}s, more than "
            f"{DEAD_AFTER_MISSED_KEEPALIVES} keepalives, last seq {self.last_event_seq}",
        )

    def runtime_info(self) -> tuple[int | None, str | None]:
        """``(None, None)``: no pid to reap and no gateway socket to abort through.

        Matches ``ProviderBase.runtime_info``'s own default rather than inventing a
        shape, so a caller that already handles the no-pid provider handles this one
        with no branch of its own.
        """
        return (None, None)

    @property
    def identifier(self) -> str:
        """What stands where a pid would stand, e.g. ``agentcore:6f2c...``."""
        return f"{REMOTE_IDENTIFIER_SCHEME}:{self.session_id}"

    @property
    def shares_session(self) -> bool:
        """False. See the module docstring -- the third of three refusals."""
        return False
