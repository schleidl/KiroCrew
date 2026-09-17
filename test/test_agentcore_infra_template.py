"""Shape tests for ``packaging/agentcore-worker/infra/template.yaml``.

The reference CDK stack's strongest guard was ``cdk/test/isolation.test.mjs``,
which asserted a role's permitted actions by exact-set equality. The role it
pinned is deliberately absent here (kiro-cli authenticates with a bearer token,
not SigV4), but the technique carries over: assert the SHAPE of the template so a
later edit cannot quietly reintroduce a coordinate that only fails at deploy time.

What these tests exist to stop, concretely: the AgentCore runtime validates its
ECR pull AT CREATE TIME, so a runtime pointed at a tag that does not exist yet is
a FAILED CREATE that takes the stack with it -- not a running runtime reporting a
pull error. That makes a one-pass bring-up into an empty account impossible, and
makes ``CreateRuntime`` load-bearing rather than cosmetic.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml
from yaml_helpers import load_with

_TEMPLATE = (
    Path(__file__).resolve().parents[1]
    / "packaging"
    / "agentcore-worker"
    / "infra"
    / "template.yaml"
)

_RUNTIME_LOGICAL_ID = "WorkerRuntime"
_RUNTIME_CONDITION = "IsRuntimeEnabled"


class _CfnLoader(yaml.SafeLoader):
    """A SafeLoader that keeps intrinsic tags DISTINGUISHABLE.

    A catch-all that flattens every ``!``-tag to its payload would make ``!If``
    indistinguishable from a plain three-element list, and the whole point of
    :func:`test_every_runtime_reference_is_gated` is to tell them apart.
    """


def _scalar_intrinsic(name: str):
    def _construct(loader: yaml.SafeLoader, node: yaml.Node) -> dict[str, Any]:
        if isinstance(node, yaml.ScalarNode):
            return {name: loader.construct_scalar(node)}
        if isinstance(node, yaml.SequenceNode):
            return {name: loader.construct_sequence(node, deep=True)}
        return {name: loader.construct_mapping(node, deep=True)}

    return _construct


for _tag, _fn_name in (
    ("!If", "Fn::If"),
    ("!Sub", "Fn::Sub"),
    ("!GetAtt", "Fn::GetAtt"),
    ("!Ref", "Ref"),
    ("!Equals", "Fn::Equals"),
    ("!Not", "Fn::Not"),
    ("!And", "Fn::And"),
    ("!Or", "Fn::Or"),
):
    _CfnLoader.add_constructor(_tag, _scalar_intrinsic(_fn_name))


def _ignore_unknown_tag(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node) -> Any:
    """Tolerate any intrinsic these tests do not reason about."""
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_mapping(node, deep=True)


_CfnLoader.add_multi_constructor(None, _ignore_unknown_tag)


@pytest.fixture(scope="module")
def tmpl() -> dict[str, Any]:
    with open(_TEMPLATE, encoding="utf-8") as fh:
        return load_with(_CfnLoader, fh)


def _mentions_runtime(node: Any) -> bool:
    if isinstance(node, str):
        return _RUNTIME_LOGICAL_ID in node
    if isinstance(node, dict):
        return any(_mentions_runtime(v) for v in node.values())
    if isinstance(node, list):
        return any(_mentions_runtime(v) for v in node)
    return False


def _ungated_runtime_references(node: Any, gated: bool = False) -> list[str]:
    """Return every reference to the runtime NOT dominated by its condition.

    ``gated`` becomes true once the walk descends into the true-branch of an
    ``Fn::If`` on ``IsRuntimeEnabled``, which is how a reference inside an
    otherwise-unconditional resource is allowed to stand.
    """
    if isinstance(node, str):
        return [] if gated or _RUNTIME_LOGICAL_ID not in node else [node]
    if isinstance(node, list):
        return [hit for item in node for hit in _ungated_runtime_references(item, gated)]
    if not isinstance(node, dict):
        return []

    branch = node.get("Fn::If")
    if isinstance(branch, list) and len(branch) == 3 and branch[0] == _RUNTIME_CONDITION:
        # branch[1] is reached only when the runtime exists; branch[2] is not.
        return _ungated_runtime_references(branch[1], True) + _ungated_runtime_references(
            branch[2], gated
        )
    return [hit for value in node.values() for hit in _ungated_runtime_references(value, gated)]


def test_the_runtime_is_conditional(tmpl: dict[str, Any]) -> None:
    """A one-pass bring-up cannot work, so the runtime must be skippable."""
    runtime = tmpl["Resources"][_RUNTIME_LOGICAL_ID]
    assert runtime["Condition"] == _RUNTIME_CONDITION, (
        "WorkerRuntime must be gated on IsRuntimeEnabled. Without it, deploying "
        "into an account with no image in ECR fails the resource and rolls the "
        "whole stack back."
    )
    assert tmpl["Conditions"][_RUNTIME_CONDITION] == {
        "Fn::Equals": [{"Ref": "CreateRuntime"}, "true"]
    }


def test_create_runtime_defaults_to_true(tmpl: dict[str, Any]) -> None:
    """Defaulting to false would DELETE a live runtime on a redeploy that
    forgot the flag, which is worse than the failure it would prevent."""
    param = tmpl["Parameters"]["CreateRuntime"]
    assert param["Default"] == "true"
    assert sorted(param["AllowedValues"]) == ["false", "true"]


def test_every_runtime_reference_is_gated(tmpl: dict[str, Any]) -> None:
    """The generalizable half: a NEW reference to the runtime cannot land ungated.

    An unconditional resource or output that reads a conditional resource is an
    unresolvable reference, and CloudFormation reports it as a template error with
    no hint about which pass caused it.
    """
    offenders: dict[str, list[str]] = {}

    for logical_id, body in tmpl["Resources"].items():
        if logical_id == _RUNTIME_LOGICAL_ID or body.get("Condition") == _RUNTIME_CONDITION:
            continue
        hits = _ungated_runtime_references(body)
        if hits:
            offenders[f"Resources.{logical_id}"] = hits

    for name, body in tmpl["Outputs"].items():
        if body.get("Condition") == _RUNTIME_CONDITION:
            continue
        hits = _ungated_runtime_references(body)
        if hits:
            offenders[f"Outputs.{name}"] = hits

    assert not offenders, (
        "these reference WorkerRuntime without being gated on IsRuntimeEnabled -- "
        f"add `Condition: {_RUNTIME_CONDITION}`, or move the reference into the "
        f"true-branch of an Fn::If on it: {offenders}"
    )


def test_runtime_outputs_are_gated(tmpl: dict[str, Any]) -> None:
    """Their ABSENCE is how a client tells a phase-one stack from a finished one."""
    for name in ("AgentRuntimeArn", "AgentRuntimeId", "RuntimeEndpointName"):
        assert tmpl["Outputs"][name].get("Condition") == _RUNTIME_CONDITION, (
            f"{name} must be absent in a CreateRuntime=false pass; an ARN that "
            "resolves to nothing is worse than no ARN."
        )


def test_operator_role_names_the_exact_runtime_arn(tmpl: dict[str, Any]) -> None:
    """Exact-set equality on the operator role's actions, in the reference's spirit.

    A prefix wildcard over ``runtime/<name>-*`` would make the policy survive a
    phase-one pass, and would also let this role reach a second runtime in the
    account. The gate is the Fn::If, not a widened resource.
    """
    policies = tmpl["Resources"]["OperatorRole"]["Properties"]["Policies"]
    branch = policies["Fn::If"]
    assert branch[0] == _RUNTIME_CONDITION
    assert branch[2] == {"Ref": "AWS::NoValue"}, "phase one must add NO policy at all"

    statements = branch[1][0]["PolicyDocument"]["Statement"]
    assert len(statements) == 1
    assert set(statements[0]["Action"]) == {
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:StopRuntimeSession",
    }, "the operator role's actions are pinned by exact set; adding one is a decision"
    assert not any(
        isinstance(r, str) and r.endswith("*") for r in statements[0]["Resource"]
    ), "no bare wildcard resource -- every entry resolves from the runtime's own ARN"


def test_no_source_is_not_selectable(tmpl: dict[str, Any]) -> None:
    """BuildSpec here is a PATH, and CodeBuild demands an inline one with
    NO_SOURCE -- so a NO_SOURCE project built from this template could never run."""
    allowed = tmpl["Parameters"]["SourceType"]["AllowedValues"]
    assert "NO_SOURCE" not in allowed
    assert "GITHUB" in allowed and "S3" in allowed


def test_rules_reject_coordinates_that_can_only_fail_later(tmpl: dict[str, Any]) -> None:
    """Rules run before any resource is touched; CreateProject errors do not."""
    rules = tmpl["Rules"]
    assert "SourceLocationIsRequired" in rules, (
        "every allowed SourceType clones a tree and resolves BuildSpecPath inside "
        "it, so an empty SourceLocation is always a deploy-time failure"
    )
    assert (
        "ImagePinsAreRequiredTogether" in rules
    ), "a URL without a digest builds whatever the host serves today"
    for name, rule in rules.items():
        assert rule["Assertions"], f"{name} asserts nothing"
        for assertion in rule["Assertions"]:
            assert assertion.get(
                "AssertDescription", ""
            ).strip(), f"{name} must say what the operator should do, not just fail"


def test_kiro_cli_url_has_no_committed_default(tmpl: dict[str, Any]) -> None:
    """The pair moves together, so neither half is baked in -- and the reason is
    version drift, not secrecy: the coordinate is in the vendor's public install
    script, and the host name carries no region."""
    assert tmpl["Parameters"]["KiroCliUrl"]["Default"] == ""
    assert tmpl["Parameters"]["KiroCliSha256"]["Default"] == ""
    description = tmpl["Parameters"]["KiroCliUrl"]["Description"]
    assert "region" not in description or "no region" in description, (
        "the old rationale claimed the release host embeds an AWS region; it does "
        "not, and a false rationale invites someone to 'fix' the wrong thing"
    )
