"""The stdio shim: it relays, it accepts ONE peer, and it refuses a wrong token.

Three properties, and each one is what keeps a byte relay from being a tunnel.
Driven through real ``os.pipe`` file descriptors and a real UNIX socket rather than
in-memory buffers: what is under test is a process whose whole contract is about
blocking streams, and a ``BytesIO`` never blocks.
"""

from __future__ import annotations

import os
import socket
import threading

import pytest

from kiro_crew.agentcore import stdio_shim


class _Shim:
    """A shim on a thread, with the two pipe ends the test writes and reads."""

    def __init__(self, socket_path: str, token: str) -> None:
        self._stdin_r, self.stdin_w = os.pipe()
        self.stdout_r, self._stdout_w = os.pipe()
        self.ready = threading.Event()
        self.status: int | None = None
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, args=(socket_path, token), daemon=True)

    def _run(self, socket_path: str, token: str) -> None:
        try:
            with os.fdopen(self._stdin_r, "rb") as stdin, os.fdopen(self._stdout_w, "wb") as out:
                self.status = stdio_shim.serve_one_connection(
                    socket_path, token, stdin=stdin, stdout=out, listen_ready=self.ready
                )
        except BaseException as exc:  # surfaced by the test rather than swallowed
            self.error = exc
            self.ready.set()

    def start(self) -> "_Shim":
        self._thread.start()
        assert self.ready.wait(5), "the shim never began listening"
        return self

    def join(self, timeout: float = 5) -> None:
        # Close the child's stdin, which is what a parent does when it tears a child
        # down: the stdin pump is blocked inside a buffered read, and closing that
        # reader from another thread would wait for the thread holding it.
        try:
            os.close(self.stdin_w)
        except OSError:
            pass
        self._thread.join(timeout)
        assert not self._thread.is_alive(), "the shim did not exit"
        if self.error is not None:
            raise self.error


def _connect(socket_path: str) -> socket.socket:
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(5)
    conn.connect(socket_path)
    return conn


def test_it_relays_both_directions(tmp_path) -> None:
    """stdin -> socket and socket -> stdout, framing preserved byte-for-byte.

    The bytes are JSON-RPC-shaped because that is what travels, but the shim never
    PARSES them -- which is the property that matters: it cannot reorder or rewrite a
    frame, so Crew's gates see exactly what the remote agent sent.
    """
    sock = str(tmp_path / "relay.sock")
    shim = _Shim(sock, "owner-token").start()
    peer = _connect(sock)
    peer.sendall(b"owner-token\n")

    os.write(shim.stdin_w, b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
    assert peer.recv(4096) == b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'

    peer.sendall(b'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n')
    assert (
        os.read(shim.stdout_r, 4096) == b'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
    )

    peer.close()
    shim.join()
    assert shim.status == stdio_shim.EXIT_OK


def test_a_mismatched_owner_token_is_refused(tmp_path) -> None:
    """A wrong token relays NOTHING and exits non-zero.

    Knowing the socket path must not be enough to drive a live agent session: the path
    is on the argv, visible in ``ps`` to every process of every user, and the token is
    deliberately not.
    """
    sock = str(tmp_path / "refuse.sock")
    shim = _Shim(sock, "owner-token").start()
    peer = _connect(sock)
    peer.sendall(b"not-the-token\n")

    # The shim shuts the connection down rather than answering, so the peer sees EOF.
    assert peer.recv(4096) == b""
    peer.close()
    shim.join()
    assert shim.status == stdio_shim.EXIT_REFUSED


def test_a_peer_that_sends_no_token_is_refused(tmp_path) -> None:
    """Closing without a handshake is a mismatch, not a pass.

    An empty presented value against a non-empty token must fail; a relay that read
    "nothing yet" as "nothing required" would authorize every local process.
    """
    sock = str(tmp_path / "silent.sock")
    shim = _Shim(sock, "owner-token").start()
    peer = _connect(sock)
    peer.close()
    shim.join()
    assert shim.status == stdio_shim.EXIT_REFUSED


def test_exactly_one_connection_is_accepted(tmp_path) -> None:
    """The listener is closed the moment a peer is accepted.

    "One connection" is a property of the SOCKET rather than of a counter a later edit
    could walk past: a second dial gets a connection error, not a queue slot, so a
    second party cannot join a session in flight.
    """
    sock = str(tmp_path / "one.sock")
    shim = _Shim(sock, "owner-token").start()
    first = _connect(sock)
    first.sendall(b"owner-token\n")
    # Round-trip once so the accept has certainly happened before the second dial.
    os.write(shim.stdin_w, b"ping\n")
    assert first.recv(64) == b"ping\n"

    with pytest.raises(OSError):
        _connect(sock)

    first.close()
    shim.join()


def test_no_owner_token_refuses_to_relay(tmp_path) -> None:
    """No owner token means no session, not an unauthenticated one."""
    with pytest.raises(ValueError, match=stdio_shim.OWNER_TOKEN_ENV):
        stdio_shim.serve_one_connection(
            str(tmp_path / "x.sock"),
            "",
            stdin=None,  # type: ignore[arg-type]
            stdout=None,  # type: ignore[arg-type]
        )


def test_main_refuses_without_the_token_env(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv(stdio_shim.OWNER_TOKEN_ENV, raising=False)
    assert stdio_shim.main(["--socket", str(tmp_path / "x.sock")]) == stdio_shim.EXIT_USAGE


def test_it_refuses_to_unlink_a_path_that_is_not_a_socket(tmp_path) -> None:
    """A stale SOCKET is reclaimed; anything else in the way is not.

    A crashed predecessor leaves its node behind and ``bind`` then fails with
    EADDRINUSE, so the stale node has to go -- but unlinking whatever is merely in the
    way would let a mistyped path delete an ordinary file.
    """
    ordinary = tmp_path / "not-a-socket"
    ordinary.write_text("data", encoding="utf-8")
    with pytest.raises(OSError, match="not a socket"):
        stdio_shim._unlink_stale(str(ordinary))
    assert ordinary.read_text(encoding="utf-8") == "data"


def test_a_stale_socket_node_is_reclaimed(tmp_path) -> None:
    sock = str(tmp_path / "stale.sock")
    leftover = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    leftover.bind(sock)
    leftover.close()
    assert os.path.exists(sock)

    shim = _Shim(sock, "owner-token").start()
    peer = _connect(sock)
    peer.sendall(b"owner-token\n")
    peer.close()
    shim.join()
    assert shim.status == stdio_shim.EXIT_OK


def test_an_unbounded_handshake_line_is_refused(tmp_path) -> None:
    """A peer that never sends a newline must not be able to grow the buffer.

    The token is a short nonce; an unbounded first line is how a relay becomes a memory
    sink for whoever can reach the socket.
    """
    sock = str(tmp_path / "flood.sock")
    shim = _Shim(sock, "owner-token").start()
    peer = _connect(sock)
    peer.sendall(b"x" * (stdio_shim.HANDSHAKE_MAX_BYTES + 1))
    peer.close()
    shim.join()
    assert shim.status == stdio_shim.EXIT_REFUSED


def test_the_shim_reads_exactly_one_environment_value() -> None:
    """It holds no credential, asserted on the source because the claim is ABSENCE.

    A behavioural test cannot show this: a relay that grew an AWS profile read, a
    signing call or a second environment credential would still relay bytes correctly.
    Comment and docstring lines are stripped first -- the module's own prose NAMES the
    things it refuses to touch, and matching that prose would make the honest
    documentation of the rule fail the rule.
    """
    import inspect

    source = inspect.getsource(stdio_shim)
    code = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith(("#", '"', "*"))
    )
    assert code.count("os.environ") == 1, "the one environment read is the owner token"
    for forbidden in ("boto3", "KIRO_API_KEY", "secretsmanager", "sigv4", "aws_"):
        assert forbidden not in code, f"the shim must hold no credential; found {forbidden!r}"
