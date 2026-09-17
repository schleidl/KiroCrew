"""The AgentCore worker's event stream: a pure sync parser with an async skin.

The worker answers ``/invocations`` with Server-Sent Events, and the gateway consumes
them from an asyncio bridge. Those are two different jobs, so this module is two
pieces rather than one::

    SseParser        bytes in, events out -- no I/O, no loop, no clock
    iter_sse_events  the same parser, driven by an async chunk source

The split is the whole point. Every property worth asserting here is a property of
CHUNK BOUNDARIES -- a frame arriving in three pieces, a keepalive between two events,
a multi-byte character cut in half by a 4096-byte read -- and none of them has
anything to do with HTTP. A parser that owned the transport could only be tested
against a server; this one is tested by calling a method with a bytes literal, and
the async wrapper stays thin enough to have no behaviour of its own to get wrong.

Why the design is what it is, decision by decision:

* **Bytes are buffered, and only WHOLE frames are decoded.** A chunk boundary can
  fall inside a multi-byte UTF-8 sequence, and decoding per chunk turns that split
  character into two replacement characters wherever the read happened to land --
  silent corruption in the middle of a payload, dependent on transfer timing. The
  frame separator ``b"\\n\\n"`` is pure ASCII and can never appear inside a multi-byte
  sequence, so a frame can be located in the byte buffer without decoding anything,
  and the decode then runs on a complete frame. ``errors="replace"`` remains, because
  a truly invalid byte must not raise and kill a live session, but it now only ever
  sees bytes that really are malformed rather than bytes that were merely early.

* **A keepalive is nothing, not an event.** ``: ping`` is an SSE comment and yields no
  ``data:`` lines at all. Surfacing it as an empty event would make every consumer
  filter it, and one that forgot would count it as progress from a worker that has
  said nothing.

* **A bad payload is a typed error that does not desynchronise the stream.** The
  offending frame is consumed from the buffer BEFORE :class:`SseMalformedEvent` is
  raised, so a caller that catches it and calls ``feed(b"")`` again keeps reading the
  frames that followed. One garbled event costs one event.

* **Truncation is reported, never raised.** :meth:`SseParser.close` returns a bool and
  ``iter_sse_events`` simply ends. A stream that stops mid-frame is a transport drop,
  and whether that is fatal depends on something the parser cannot see: whether the
  worker's terminal event had already arrived. That judgement belongs to the bridge,
  so this module hands it the fact and no opinion.

Standard library only -- no HTTP client, no AWS SDK. The bytes arrive from whoever
already owns the connection.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

__all__ = [
    "SseMalformedEvent",
    "SseParser",
    "iter_sse_events",
]

#: Frames are separated by a blank line, and by nothing else. Deliberately not
#: ``\r\n\r\n``: the worker emits ``\n``, and accepting more separators than the
#: producer emits only creates ways to split a frame that never occur in practice.
_FRAME_SEP = b"\n\n"

_DATA_FIELD = "data:"


class SseMalformedEvent(Exception):
    """One frame's payload was not a JSON object. Carries the offending raw text.

    Raised for a payload that is not JSON at all AND for JSON that decodes to
    something other than an object -- a list, a number, a bare string. The contract
    with the worker is exactly one object per frame, and a consumer that accepted a
    list here would go on to call ``.get()`` on it somewhere further away from the
    cause.

    ``raw`` is the rejoined payload text as it arrived, which is the only thing that
    makes such a frame diagnosable after the fact; the underlying decode error, when
    there was one, is chained as ``__cause__``.
    """

    def __init__(self, raw: str, cause: Exception | None = None) -> None:
        super().__init__(f"SSE frame payload is not a JSON object: {raw!r}")
        self.raw = raw
        if cause is not None:
            self.__cause__ = cause


class SseParser:
    """Incremental, sync, pure. One instance per stream.

    Holds two pieces of state: the bytes of a frame that has not been terminated yet,
    and events that were parsed but not yet handed to the caller (see :meth:`feed`).
    """

    def __init__(self) -> None:
        self._buf = b""
        self._pending: list[dict[str, Any]] = []
        self._error: SseMalformedEvent | None = None

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        """Consume *chunk*, returning the events it completed, in order.

        A partial trailing frame stays buffered for a later chunk, so a caller may
        hand over reads of any size -- one byte or one megabyte -- without arranging
        anything. Keepalives return nothing. ``feed(b"")`` is legal and useful: it
        drains whatever is queued without adding input.

        Raises :class:`SseMalformedEvent` for a frame whose payload is not a JSON
        object, after that frame has been consumed -- but never AHEAD of events that
        preceded it in the stream. An exception has one exit path and a return value
        has another, so when a chunk carries good frames before a bad one those events
        are returned first and the error is held for the next call. Parsing then stops
        at the bad frame until the error has been raised, which is what keeps the two
        orderings from crossing.

        The alternative -- raising immediately and returning the earlier events
        afterwards -- loses nothing either, but it hands the error to a caller that has
        not yet seen the events before it, and a caller that treats a malformed frame
        as fatal would then discard events it had already been given. Stream order is
        the safer default because it cannot be got wrong downstream.
        """
        if chunk:
            self._buf += chunk
        while self._error is None and _FRAME_SEP in self._buf:
            raw, self._buf = self._buf.split(_FRAME_SEP, 1)
            try:
                event = _parse_frame(raw.decode("utf-8", errors="replace"))
            except SseMalformedEvent as exc:
                self._error = exc
                break
            if event is not None:
                self._pending.append(event)
        if self._pending:
            drained, self._pending = self._pending, []
            return drained
        if self._error is not None:
            error, self._error = self._error, None
            raise error
        return []

    def close(self) -> bool:
        """True if the stream ended on a frame boundary, False if a frame was cut off.

        Never raises: this is called on the way out, including on the error path, and
        a parser that raised during cleanup would mask whatever actually ended the
        stream.
        """
        return not self._buf


def _parse_frame(text: str) -> dict[str, Any] | None:
    """One frame's decoded text to one event, or ``None`` for a comment/keepalive.

    Multi-line data is legal and is rejoined with ``\\n`` before parsing, per SSE:
    a producer that pretty-printed its JSON, or a payload carrying an embedded
    newline, arrives as several ``data:`` lines that mean one value. Any other field
    is ignored rather than rejected -- the worker sends none today, and a future
    ``id:`` line must not turn a readable stream into an error.
    """
    lines = [line for line in text.split("\n") if line.startswith(_DATA_FIELD)]
    if not lines:
        return None
    payload = "\n".join(_field_value(line) for line in lines)
    try:
        decoded = json.loads(payload)
    except ValueError as exc:
        raise SseMalformedEvent(payload, exc) from exc
    if not isinstance(decoded, dict):
        raise SseMalformedEvent(payload)
    return decoded


def _field_value(line: str) -> str:
    """The value of a ``data:`` line: everything after the colon, less ONE space.

    One space, not ``lstrip()``: SSE defines a single optional space after the colon
    as part of the framing, and every further space is data. It makes no difference to
    a JSON object, and it would make a difference to a payload that is ever anything
    else.
    """
    value = line[len(_DATA_FIELD) :]
    return value[1:] if value.startswith(" ") else value


async def iter_sse_events(chunks: AsyncIterator[bytes]) -> AsyncIterator[dict[str, Any]]:
    """Yield the events carried by *chunks*, an async source of raw stream bytes.

    A thin skin over :class:`SseParser` and nothing more: no retry, no timeout, no
    reconnect. Those need a policy, a policy needs a caller's context, and burying one
    here would make it the same policy for every stream.

    Ends when *chunks* is exhausted, and does NOT raise for a partial frame left
    buffered -- see the module docstring: a truncated stream is the bridge's business
    to notice, by the absence of a terminal event. :class:`SseMalformedEvent` DOES
    propagate, because a garbled frame is a fact about the payload rather than about
    the transport, and swallowing it here would hide a worker bug behind a gap in the
    event sequence.
    """
    parser = SseParser()
    async for chunk in chunks:
        for event in parser.feed(chunk):
            yield event
