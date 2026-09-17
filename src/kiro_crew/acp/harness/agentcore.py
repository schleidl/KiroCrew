"""The AgentCore remote harness: an argv that launches a byte relay.

The harness seam is argv-only -- ``SpawnPlan.argv`` built from a
:class:`~kiro_crew.acp.harness.base.SpawnContext` -- which is the whole reason a
remote agent can land here without touching the ACP transport. This harness returns
the argv of :mod:`kiro_crew.agentcore.stdio_shim`, whose stdin and stdout are the
pipes ``AcpClient`` already writes to and whose other end is one UNIX socket to the
bridge in the gateway process (RFC phase 3).

Two coordinates are needed and neither is Crew's to invent: the socket path the
bridge is listening for, and the per-session owner token that authorizes driving
that session. The BRIDGE mints both, so this harness READS them off the spawn's own
environment snapshot rather than deriving them -- deriving a socket path would make
two processes agree by coincidence, and minting a token here would put it in the
process that must not hold one. Absent, :meth:`AgentCoreHarness.resolve_spawn`
raises naming what is missing, which is the correct answer on a build with no
bridge: this id is not baseline-selectable, so an ordinary install never reaches it.

Nothing here generalizes the Kiro spawn path. ``KiroHarness.resolve_spawn`` keeps its
own branch, its pre-spawn agent materialization and its ``--model`` pin
(harness-parity H9); this is a separate class whose argv shares nothing with it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from kiro_crew.acp.harness._common import MembershipHarness
from kiro_crew.acp.harness.base import (
    NotificationAliases,
    SessionExtras,
    SpawnContext,
    SpawnPlan,
    TeardownPolicy,
)
from kiro_crew.acp.types import ACP_BACKEND_AGENTCORE
from kiro_crew.agentcore.stdio_shim import OWNER_TOKEN_ENV, shim_argv

#: Where the bridge publishes the socket it is listening on for THIS session.
SOCKET_PATH_ENV = "KIROCREW_AGENTCORE_SOCKET"

#: The poll interval the RFC declares for a reconnecting stream, in milliseconds.
#:
#: Named here rather than left to the bridge because it is a LATENCY BUDGET, not an
#: implementation detail: a tool approval answered on a live stream costs about ten
#: milliseconds, and the same approval answered while reconnecting costs one interval.
#: Each tick is also a billed invocation, so shortening it to chase approval latency
#: raises cost on every reconnect. WP3's bridge reads this constant.
RECONNECT_POLL_INTERVAL_MS = 3000


def _resolve_runtime_coordinates(environ: Any) -> tuple[str, str]:
    """``(socket_path, owner_token)`` from *environ*, or ``("", "")``.

    Its own function so the missing-coordinate path is patchable in a test the same
    way every other harness's binary resolution is: the universal invariant that no
    harness returns an argv it cannot actually launch is asserted by emptying each
    host's own resolver, and a host with nothing to empty is the one host that
    invariant cannot be asserted against.
    """
    return (
        str(environ.get(SOCKET_PATH_ENV, "") or ""),
        str(environ.get(OWNER_TOKEN_ENV, "") or ""),
    )


class AgentCoreHarness(MembershipHarness):
    """The remote host, reached through a local relay."""

    backend = ACP_BACKEND_AGENTCORE

    # ── Seam 1: spawn ──

    async def resolve_spawn(self, ctx: SpawnContext) -> SpawnPlan:
        """The stdio shim's argv, or a refusal naming the missing coordinate.

        No credential mask is resolved, and that is required rather than omitted.
        This host is ``Routing.AGENT_SPEC`` -- the remote child is
        ``kiro-cli --agent <name>``, so its privileged tools ask by exactly the
        mechanism the local Kiro path uses -- and
        ``test_an_enforced_host_may_not_spawn_without_a_mask`` asserts both halves of
        that member: a non-AGENT_SPEC host must put a hidden-dirs mask on its plan and
        an AGENT_SPEC host must not. The mask compensates for privileged tools that do
        not ask; there is nothing here to compensate for, and the LOCAL process this
        argv starts is a byte relay that reads no file at all.

        ``host_auth`` stays False, and here that is a security decision rather than an
        unmeasured capability: the peer on the far end of this socket is a bridge, not
        a process Crew spawned, so Crew must never answer a credential callback
        arriving over it. The id is correspondingly absent from
        ``ACP_BACKENDS_HOST_AUTH_CALLBACK``.
        """
        from kiro_crew.acp.session_handle import AcpRuntimeError

        socket_path, owner_token = _resolve_runtime_coordinates(ctx.environ)
        missing = [
            name
            for name, value in ((SOCKET_PATH_ENV, socket_path), (OWNER_TOKEN_ENV, owner_token))
            if not value
        ]
        if missing:
            raise AcpRuntimeError(
                "the agentcore harness resolved no runtime coordinates for this spawn: "
                f"{', '.join(missing)} not found in the spawn environment. The bridge "
                "publishes both per session, so this means no bridge is serving this "
                "spawn -- install the kirocrew[agentcore] extra and enable "
                "capabilities.remote_exec."
            )
        return SpawnPlan(argv=shim_argv(socket_path))

    def apply_spawn_env(self, env: dict[str, str]) -> None:
        """Nothing to add. The shim inherits the owner token it was given.

        Deliberately not a re-export of the token into the child env from some other
        source: the value the shim compares against must be the one the BRIDGE minted
        for this session, and a second writer here is a second place it can be wrong.
        """
        return None

    @property
    def verifies_agent_activation(self) -> bool:
        """False. The agent is named in the WORKER's own argv inside the container.

        A local ``set_mode`` round-trip would be asserting about a process on this
        machine; there is none. WP3's worker names the agent when it launches the
        child, and confirmation belongs there.
        """
        return False

    # ── Seam 2: initialize ──

    @property
    def protocol_version(self) -> Any:
        """ACP v1 as an INTEGER, kept as its own literal (harness-parity H10).

        Not folded onto kiro-cli's date-stamped ``2025-08-22`` even though the remote
        child is kiro-cli: Spike C observed an integer on this wire, the worker
        forwards ``initialize`` rather than asserting a version, and the hosts
        genuinely disagree on the version's TYPE. One shared handshake would break a
        host outright.
        """
        return 1

    @property
    def client_capabilities(self) -> dict[str, Any]:
        """Empty, and a per-host literal rather than a share of Kiro's.

        Every capability Crew advertises here is a promise about what CREW answers
        across this socket, and the answering half is WP3's bridge. Advertising a
        capability before the bridge implements it is how a remote agent's first
        request goes unanswered.
        """
        return {}

    # ── Seam 3: session/new and session/load extras ──

    async def session_extras(
        self,
        agent: str,
        *,
        work_dir: str | Path | None,
        mcp_gateway_overlay: Any = None,
        member_dispatch: bool = False,
    ) -> SessionExtras:
        """None. Not a member of ``ACP_BACKENDS_MEMBER_DISPATCH``, and a local
        ``work_dir`` names nothing inside the container -- the worker clones the
        repository itself."""
        return SessionExtras()

    def session_mcp_servers(
        self,
        requested: list[dict[str, Any]],
        *,
        agent_capabilities: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """``requested`` unchanged.

        Crew sends this host no array today (``PROJECTIONS`` declares NO_CHANNEL, and
        the id is outside ``ACP_BACKENDS_SESSION_MCP_ARRAY``), so this is reached with
        an empty list. Narrowing to ``[]`` regardless would silently strip every tool
        from a session the moment WP3 does start passing one.
        """
        return requested

    # ── Seam 4: inbound requests the host answers ──

    @property
    def host_answered_methods(self) -> tuple[str, ...]:
        """None. Outside ``ACP_BACKENDS_HOST_AUTH_CALLBACK``, so no request arriving
        over this socket is ever answered with a Crew credential."""
        return ()

    async def answer_request(self, method: str) -> dict[str, Any]:
        """Unreachable: :attr:`host_answered_methods` is empty, so a request from this
        host is answered ``-32601`` before it gets here."""
        raise NotImplementedError(f"the agentcore harness answers no request ({method!r})")

    # ── Seam 5: notification aliases ──

    @property
    def notification_aliases(self) -> NotificationAliases:
        """The standard spelling only.

        The remote child is kiro-cli and does send the ``_kiro.dev`` aliases, but the
        id is outside ``ACP_BACKENDS_KIRO_SLASH_COMMANDS`` and the kiro family's own
        alias tuple carries subagent-list and MCP-init notifications this transport
        has not been observed forwarding. Claiming the family vocabulary would have
        Crew wait on frames the worker may drop; WP3 widens this with a capture.
        """
        return NotificationAliases(session_update=("session/update",))

    # ── Seam 6: teardown ──

    @property
    def teardown(self) -> TeardownPolicy:
        """A notification, not a request.

        The worker session is single-turn: at ``turn_end`` it emits ``done`` and
        terminates the child, so a teardown REQUEST would spend a caller's whole
        teardown budget waiting for a reply from a process that is correctly already
        gone. The bridge's own ``stop`` action is what actually reclaims the container.
        """
        return TeardownPolicy(method="session/cancel", notification=True)
