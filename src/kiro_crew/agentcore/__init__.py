"""AgentCore remote agents: the local half.

Public core, no AWS SDK. Everything that talks to Bedrock AgentCore lives behind
the ``kirocrew[agentcore]`` extra and arrives with the bridge (RFC phase 3); what
is here is the piece that must work without it.

:mod:`kiro_crew.agentcore.stdio_shim` is that piece. ``AcpClient`` writes
newline-framed JSON-RPC to a child's stdin and reads its stdout, and there is no
stream-pair seam to substitute a socket into -- so the remote harness's argv
launches a child whose whole job is to BE that seam: stdin and stdout on one side,
one UNIX socket on the other. It holds no credential, accepts exactly one
connection, and refuses a peer that cannot present the session's owner token.

Deliberately not a general-purpose tunnel. See the module docstring for what was
refused and why.
"""

from __future__ import annotations

__all__: list[str] = []
