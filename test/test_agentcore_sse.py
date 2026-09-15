"""The SSE reader, driven entirely by bytes literals -- no server, no socket, no loop.

Every test here is a statement about a CHUNK BOUNDARY, because that is where this
parser can go wrong: a frame arriving in pieces, a multi-byte character cut in half, a
keepalive between two events, a garbled payload that must not take the rest of the
stream with it. None of that needs HTTP, so none of it is tested through HTTP -- the
inputs are the exact byte sequences a socket read would hand over, spelled out where a
reader can see them.
"""

from __future__ import annotations

import ast
import json
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from kiro_crew.agentcore import sse
from kiro_crew.agentcore.sse import SseMalformedEvent, SseParser, iter_sse_events


def _frame(obj: object) -> bytes:
    """One well-formed data frame carrying *obj*, exactly as the worker emits it."""
    return f"data: {json.dumps(obj)}\n\n".encode("utf-8")


def _drain(parser: SseParser, chunks: list[bytes]) -> list[dict]:
    events: list[dict] = []
    for chunk in chunks:
        events.extend(parser.feed(chunk))
    return events


def test_a_whole_event_in_one_chunk() -> None:
    parser = SseParser()
    assert parser.feed(_frame({"seq": 1, "type": "chunk"})) == [{"seq": 1, "type": "chunk"}]
    assert parser.close() is True


def test_an_event_split_across_two_chunks() -> None:
    """Nothing is surfaced until the blank line arrives; then the whole event is."""
    raw = _frame({"seq": 1, "text": "hello"})
    parser = SseParser()
    assert parser.feed(raw[:9]) == []
    assert parser.feed(raw[9:]) == [{"seq": 1, "text": "hello"}]
    assert parser.close() is True


def test_an_event_split_across_three_chunks_including_the_separator() -> None:
    """The split falls INSIDE ``\\n\\n``, which is the boundary the parser matches on."""
    raw = _frame({"seq": 2})
    head, sep_first, sep_second = raw[:-2], raw[-2:-1], raw[-1:]
    parser = SseParser()
    assert parser.feed(head) == []
    assert parser.feed(sep_first) == []
    assert parser.feed(sep_second) == [{"seq": 2}]
    assert parser.close() is True


def test_an_event_fed_one_byte_at_a_time() -> None:
    raw = _frame({"seq": 3, "type": "acp", "payload": {"method": "session/update"}})
    parser = SseParser()
    events = _drain(parser, [raw[i : i + 1] for i in range(len(raw))])
    assert events == [{"seq": 3, "type": "acp", "payload": {"method": "session/update"}}]
    assert parser.close() is True


def test_a_multibyte_character_split_across_a_chunk_boundary() -> None:
    """The split character survives intact -- the decode runs on whole frames only.

    A per-chunk ``bytes.decode`` is what this asserts against: it would replace the two
    halves of the euro sign with two replacement characters and hand the bridge a
    corrupted payload, with nothing raising anywhere.
    """
    payload = json.dumps({"seq": 4, "text": "Grüße € 世界"}, ensure_ascii=False)
    raw = f"data: {payload}\n\n".encode("utf-8")
    euro = "€".encode("utf-8")
    cut = raw.index(euro) + 1  # mid-character: one byte of the euro sign on each side
    parser = SseParser()
    assert parser.feed(raw[:cut]) == []
    assert parser.feed(raw[cut:]) == [{"seq": 4, "text": "Grüße € 世界"}]
    assert parser.close() is True


def test_several_events_in_one_chunk_in_order() -> None:
    chunk = b"".join(_frame({"seq": n}) for n in (1, 2, 3))
    parser = SseParser()
    assert parser.feed(chunk) == [{"seq": 1}, {"seq": 2}, {"seq": 3}]
    assert parser.close() is True


def test_a_keepalive_between_two_events_is_swallowed() -> None:
    """``: ping`` yields no data lines, so it is not an event and is not counted."""
    parser = SseParser()
    chunk = _frame({"seq": 1}) + b": ping\n\n" + _frame({"seq": 2})
    assert parser.feed(chunk) == [{"seq": 1}, {"seq": 2}]
    assert parser.feed(b": ping\n\n") == []
    assert parser.close() is True


def test_multi_line_data_is_rejoined_before_parsing() -> None:
    """Several ``data:`` lines are ONE value, per SSE -- a pretty-printed payload."""
    parser = SseParser()
    assert parser.feed(b'data: {"seq": 5,\ndata:  "type": "chunk"}\n\n') == [
        {"seq": 5, "type": "chunk"}
    ]


def test_a_non_json_payload_raises_and_the_next_event_still_parses() -> None:
    """The bad frame is consumed before the raise, so the stream does not desynchronise."""
    parser = SseParser()
    with pytest.raises(SseMalformedEvent) as caught:
        parser.feed(b"data: not json at all\n\n" + _frame({"seq": 6}))
    assert caught.value.raw == "not json at all"
    assert isinstance(caught.value.__cause__, ValueError)
    # The frame that FOLLOWED the bad one is still buffered and still readable.
    assert parser.feed(b"") == [{"seq": 6}]
    assert parser.close() is True


def test_events_completed_before_a_bad_frame_arrive_before_the_error() -> None:
    """Stream order wins: the good frames come back first, the error on the next call.

    Parsing stops AT the bad frame, so the event that followed it is not consumed
    early either -- it arrives only after the error has been raised.
    """
    parser = SseParser()
    assert parser.feed(_frame({"seq": 1}) + b"data: {oops\n\n" + _frame({"seq": 2})) == [
        {"seq": 1}
    ]
    with pytest.raises(SseMalformedEvent):
        parser.feed(b"")
    assert parser.feed(b"") == [{"seq": 2}]


def test_a_bad_frame_with_nothing_before_it_raises_at_once() -> None:
    """No events to hand over first, so the error is not deferred."""
    parser = SseParser()
    with pytest.raises(SseMalformedEvent):
        parser.feed(b"data: {oops\n\n" + _frame({"seq": 1}))
    assert parser.feed(b"") == [{"seq": 1}]


@pytest.mark.parametrize("payload", ['["a", "list"]', '"a bare string"', "42", "null"])
def test_a_json_payload_that_is_not_an_object_is_malformed(payload: str) -> None:
    """The contract is one OBJECT per frame; a valid-JSON non-object is still a defect."""
    parser = SseParser()
    with pytest.raises(SseMalformedEvent) as caught:
        parser.feed(f"data: {payload}\n\n".encode("utf-8"))
    assert caught.value.raw == payload


def test_the_raw_text_survives_in_the_exception_message() -> None:
    """The offending text is the only thing that makes such a frame diagnosable later."""
    parser = SseParser()
    with pytest.raises(SseMalformedEvent, match="totally-not-json"):
        parser.feed(b"data: totally-not-json\n\n")


def test_close_is_false_on_a_truncated_trailing_frame() -> None:
    parser = SseParser()
    assert parser.feed(_frame({"seq": 1}) + b'data: {"seq": 2}') == [{"seq": 1}]
    assert parser.close() is False


def test_close_is_true_on_a_clean_end() -> None:
    parser = SseParser()
    parser.feed(_frame({"seq": 1}))
    assert parser.close() is True


def test_close_is_true_on_a_stream_that_carried_nothing() -> None:
    assert SseParser().close() is True


def test_a_trailing_keepalive_leaves_the_buffer_clean() -> None:
    parser = SseParser()
    parser.feed(_frame({"seq": 1}) + b": ping\n\n")
    assert parser.close() is True


@pytest.mark.asyncio
async def test_the_async_iterator_yields_the_same_events_in_order() -> None:
    """The wrapper adds nothing: same chunks, same events, and the splits still hold."""
    first, second, third = (_frame({"seq": n}) for n in (1, 2, 3))
    chunks = [
        first[:3],
        first[3:],
        b": ping\n\n",
        second + third[:4],
        third[4:],
        _frame({"seq": 4}),
    ]

    async def source() -> AsyncIterator[bytes]:
        for chunk in chunks:
            yield chunk

    assert [event async for event in iter_sse_events(source())] == [
        {"seq": 1},
        {"seq": 2},
        {"seq": 3},
        {"seq": 4},
    ]


@pytest.mark.asyncio
async def test_the_async_iterator_ends_quietly_on_a_truncated_stream() -> None:
    """A transport drop is the bridge's to detect, by the missing terminal event."""

    async def source() -> AsyncIterator[bytes]:
        yield _frame({"seq": 1})
        yield b'data: {"seq": 2'

    assert [event async for event in iter_sse_events(source())] == [{"seq": 1}]


@pytest.mark.asyncio
async def test_the_async_iterator_propagates_a_malformed_event() -> None:
    """A garbled payload is a fact about the worker, not something to hide as a gap."""

    async def source() -> AsyncIterator[bytes]:
        yield b"data: {not json\n\n"

    with pytest.raises(SseMalformedEvent):
        async for _event in iter_sse_events(source()):
            pass


@pytest.mark.asyncio
async def test_the_async_iterator_over_an_empty_stream_yields_nothing() -> None:
    async def source() -> AsyncIterator[bytes]:
        return
        yield b""  # pragma: no cover - makes this an async generator

    assert [event async for event in iter_sse_events(source())] == []


def test_the_module_imports_nothing_outside_the_standard_library() -> None:
    """No HTTP client, no AWS SDK, no third party at all -- asserted on the source.

    Checked by reading the imports rather than by inspecting ``sys.modules``, which
    would pass for the wrong reason: by the time this test runs, the suite has imported
    half the world, so a stray third-party import here would already be satisfied.
    """
    source = Path(sse.__file__).read_text(encoding="utf-8")
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])
    assert imported, "the import scan found nothing, so it proves nothing"
    assert imported <= set(sys.stdlib_module_names), sorted(imported - set(sys.stdlib_module_names))
