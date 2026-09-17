"""The stdio shim: one process, two byte streams, one socket, no credential.

``AcpClient`` speaks newline-framed JSON-RPC to a child process over pipes. A
remote agent is not a child process, and there is no stream-pair seam inside the
client to substitute a socket into. So the remote harness spawns THIS module, whose
entire job is to be the missing seam:

    AcpClient  ──stdin/stdout pipes──▶  stdio_shim  ──one UNIX socket──▶  bridge

Run as ``python -m kiro_crew.agentcore.stdio_shim --socket <path>``, with the
session's owner token in :data:`OWNER_TOKEN_ENV`. The harness builds that argv
(:mod:`kiro_crew.acp.harness.agentcore`); nothing else should launch it.

What this is NOT, stated because each of these is a thing a byte relay is one edit
away from becoming, and the RFC's security argument rests on it not being one:

* **Not a tunnel.** The socket path is an argument, but the shim BINDS it and
  accepts ONE connection, then stops listening. It never dials out, so it cannot be
  pointed at a host, and a second peer cannot join a session in flight.
* **Not a credential holder.** No AWS profile, no ``KIRO_API_KEY``, no signing. The
  bridge in the gateway process signs AgentCore calls; the agent's own model
  credential exists only in Secrets Manager and in the container's memory. The one
  secret-shaped value here is the per-session owner token, which authorizes the
  PEER and buys access to nothing else.
* **Not a multiplexer.** One session, one socket, one connection. Framing is
  preserved byte-for-byte rather than parsed: the shim does not read the JSON-RPC it
  carries, so it can neither reorder nor rewrite a frame, and Crew's gates see
  exactly what the remote agent sent.

The owner token is read from the ENVIRONMENT, never from argv: an argv is visible in
``ps`` to every process of every user on the machine, and a token that authorizes
driving a live agent session does not belong there. The PEER presents it as the
first newline-framed line on the connection; a mismatch is compared in constant
time, refused, and the process exits non-zero rather than relaying a byte.
"""

from __future__ import annotations

import argparse
import errno
import hmac
import logging
import os
import socket
import sys
import threading
from typing import BinaryIO

logger = logging.getLogger(__name__)

__all__ = [
    "EXIT_OK",
    "EXIT_REFUSED",
    "EXIT_USAGE",
    "HANDSHAKE_MAX_BYTES",
    "OWNER_TOKEN_ENV",
    "main",
    "serve_one_connection",
    "shim_argv",
]

#: Where the per-session owner token is read from. Never an argv element.
OWNER_TOKEN_ENV = "KIROCREW_AGENTCORE_OWNER_TOKEN"

#: A handshake line longer than this is refused unread. The token is a short nonce;
#: an unbounded first line is how a relay is turned into a memory sink by a peer
#: that never sends a newline.
HANDSHAKE_MAX_BYTES = 4096

#: The relay chunk size. Large enough that a big tool result is not split into
#: thousands of writes, small enough that a stalled peer cannot pin much memory.
_CHUNK = 65536

EXIT_OK = 0
EXIT_REFUSED = 3
EXIT_USAGE = 2


def shim_argv(socket_path: str, *, python: str | None = None) -> list[str]:
    """The argv that launches this shim for *socket_path*.

    Lives here rather than in the harness so the launcher and the launched agree on
    the module path by construction: a harness that spelled ``-m`` differently would
    fail at spawn with an import error rather than anything a reader could act on.
    """
    return [python or sys.executable, "-m", __spec__.name, "--socket", socket_path]


def _read_handshake(conn: socket.socket) -> bytes:
    """The peer's first newline-framed line, bounded.

    Returns the line without its newline, or ``b""`` when the peer closed or
    overran :data:`HANDSHAKE_MAX_BYTES` -- both of which the caller refuses. Read one
    byte at a time on purpose: the handshake is a short line, and reading ahead would
    consume the first bytes of the relayed stream into a buffer this function throws
    away.
    """
    buf = bytearray()
    while len(buf) < HANDSHAKE_MAX_BYTES:
        try:
            chunk = conn.recv(1)
        except OSError:
            return b""
        if not chunk:
            return b""
        if chunk == b"\n":
            return bytes(buf)
        buf.extend(chunk)
    return b""


def _pump(name: str, read: BinaryIO, write_all: "object") -> None:
    """Copy *read* into *write_all* until EOF, flushing every chunk.

    Flushing per chunk is not tidiness: a JSON-RPC request left in a buffer is a
    request the peer never answers, so the caller waits for a reply that was written
    but not sent, and the session looks hung rather than broken.
    """
    send = write_all  # type: ignore[assignment]
    try:
        while True:
            chunk = read.read1(_CHUNK) if hasattr(read, "read1") else read.read(_CHUNK)
            if not chunk:
                return
            send(chunk)  # type: ignore[operator]
    except OSError as exc:  # peer went away mid-copy; the other direction ends too
        logger.debug("agentcore shim: %s pump ended (%s)", name, exc)


def serve_one_connection(
    socket_path: str,
    owner_token: str,
    *,
    stdin: BinaryIO,
    stdout: BinaryIO,
    listen_ready: threading.Event | None = None,
) -> int:
    """Bind *socket_path*, accept ONE peer, verify its token, then relay.

    Returns a process exit status: :data:`EXIT_OK` when the relay ran and ended at
    EOF, :data:`EXIT_REFUSED` when the peer presented a token that is not
    *owner_token* (or presented none).

    Returns when the SOCKET side ends, which is what closes a turn. The stdin pump is
    a daemon thread that ends at stdin EOF, so it can still be blocked on a read when
    this returns: the process exits immediately afterwards and takes it with it. An
    IN-PROCESS caller (a test) must therefore close the write end of the stdin pipe
    before it joins, exactly as a parent closes a child's stdin when tearing it down —
    closing a buffered reader another thread is blocked inside waits for that thread.

    The listener is closed the moment a connection is accepted, so "exactly one
    connection" is a property of the socket rather than of a counter this function
    could be edited past. *listen_ready* is set once the socket is listening, for a
    caller that must not race the bind.
    """
    if not owner_token:
        raise ValueError(
            f"the agentcore stdio shim needs the session owner token in {OWNER_TOKEN_ENV}; "
            "without it any local process could drive this session"
        )

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        _unlink_stale(socket_path)
        # 0o600 before bind, so the socket is never briefly world-connectable. The
        # umask is the only way to set a UNIX socket's mode at creation; chmod after
        # bind leaves a window.
        old_umask = os.umask(0o077)
        try:
            listener.bind(socket_path)
        finally:
            os.umask(old_umask)
        listener.listen(1)
        if listen_ready is not None:
            listen_ready.set()
        conn, _ = listener.accept()
    finally:
        listener.close()

    with conn:
        # One peer only: the listener is already closed above, so a second dial gets
        # ECONNREFUSED rather than a queue slot.
        presented = _read_handshake(conn)
        if not hmac.compare_digest(presented, owner_token.encode("utf-8")):
            logger.error(
                "agentcore shim: refusing the peer on %s -- owner token mismatch", socket_path
            )
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return EXIT_REFUSED

        # stdin -> socket on a worker; socket -> stdout on this thread, so the
        # process exits when the AGENT's side ends, which is what closes the turn.
        to_socket = threading.Thread(
            target=_pump,
            args=("stdin->socket", stdin, conn.sendall),
            name="agentcore-shim-out",
            daemon=True,
        )
        to_socket.start()
        _pump("socket->stdout", conn.makefile("rb"), _writer(stdout))
    return EXIT_OK


def _writer(stream: BinaryIO):
    """A write-and-flush callable over *stream*."""

    def write_all(chunk: bytes) -> None:
        stream.write(chunk)
        stream.flush()

    return write_all


def _unlink_stale(socket_path: str) -> None:
    """Remove a leftover socket file, and only a leftover socket file.

    A crashed predecessor leaves its node behind and ``bind`` then fails with
    EADDRINUSE. Unlinking anything that is merely IN THE WAY would let a mistyped
    path delete an ordinary file, so the node is removed only when it IS a socket.
    """
    try:
        import stat

        mode = os.lstat(socket_path).st_mode
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return
        raise
    if not stat.S_ISSOCK(mode):
        raise OSError(
            errno.EADDRINUSE,
            f"{socket_path!r} exists and is not a socket; refusing to unlink it",
        )
    os.unlink(socket_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="kiro_crew.agentcore.stdio_shim",
        description="Relay newline-framed JSON-RPC between this process's stdio and one "
        "UNIX socket. Launched by the agentcore harness; holds no credential.",
    )
    parser.add_argument(
        "--socket",
        required=True,
        help="UNIX socket path to bind. Exactly one connection is accepted.",
    )
    args = parser.parse_args(argv)

    token = os.environ.get(OWNER_TOKEN_ENV, "")
    if not token:
        print(
            f"{OWNER_TOKEN_ENV} is not set; refusing to relay an unauthorized session",
            file=sys.stderr,
        )
        return EXIT_USAGE

    try:
        return serve_one_connection(
            args.socket,
            token,
            stdin=sys.stdin.buffer,
            stdout=sys.stdout.buffer,
        )
    finally:
        try:
            _unlink_stale(args.socket)
        except OSError:
            pass


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
