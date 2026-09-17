# AgentCore worker infrastructure

Three files, no CDK app:

| File | What it is |
|---|---|
| `template.yaml` | The whole account inventory: ECR repository, arm64 image build project, AgentCore runtime, runtime and operator roles, four secret shells, transcript bucket, log group, optional budget. |
| `buildspec.yml` | The CodeBuild spec that builds the arm64 image **in the account** and pushes it to ECR, so no local container daemon and no 582 MiB local pull are needed. |
| `../Dockerfile` | The image the build project builds. |

Nothing in this directory contains an account id, an ARN, a region, or a secret
value. Account and region resolve from the `AWS::AccountId` / `AWS::Region` /
`AWS::Partition` pseudo parameters at deploy time; everything else is a stack
parameter. Every command below therefore takes an explicit `--profile` and
`--region` and nothing is baked in.

## Parameters

Required in practice (no usable default):

| Parameter | Notes |
|---|---|
| `KiroCliUrl` | URL of the aarch64 musl kiro-cli release archive. No default on purpose — but the reason is version drift, **not** secrecy: the coordinate is published in the vendor's own install script and release manifest, and the host name carries no region. A URL committed here would pin one version forever, and `(url, sha256)` has to move together. Resolve both with the two commands in step 1. |
| `KiroCliSha256` | The manifest's own `sha256`, or `curl -sSL "$KiroCliUrl" \| shasum -a 256` to recompute it. The Dockerfile refuses to build without it, so a rebuild can only ship the reviewed binary. A `Rules` assertion rejects one half without the other. |
| `SourceLocation` | Tree CodeBuild clones, and where `BuildSpecPath` is resolved. It must actually **contain** `packaging/agentcore-worker` — see [Where the build gets its source](#where-the-build-gets-its-source). Required: a `Rules` assertion rejects an empty value, because every allowed `SourceType` needs one. |

Worth setting deliberately:

| Parameter | Default | Notes |
|---|---|---|
| `CreateRuntime` | `true` | Whether this pass creates the AgentCore runtime. **A first bring-up must deploy once with `false`**, because AgentCore validates the ECR pull at create time and the image does not exist yet. Default `true` so a steady-state redeploy that omits the flag never deletes a live runtime. |
| `ResourceSuffix` | `""` | Set it (e.g. `isotest`) to stand an isolated stack beside a live one. It renames the runtime, the ECR repository, the secrets, the log group, the build project and the budget. |
| `AgentRuntimeName` | `agentcore_worker` | Underscores only; the service rejects hyphens. |
| `ImageTag` / `ImageTagMutability` | `latest` / `IMMUTABLE` | `IMMUTABLE` means a reviewed tag can never be repointed. Use `MUTABLE` only while iterating on `latest`. |
| `NetworkMode` | `PUBLIC` | `VPC` puts the runtime's ENIs in `VpcSubnetIds` behind `VpcSecurityGroupIds` — which is where an egress allow-list becomes enforceable. Those network resources are **not** created here; supply at least two subnets in different AZs. |
| `ValidateCommand` | `""` | The gate run on the resolved tree before anything is pushed. Empty means the gate always passes. |
| `MaxActiveSessions`, `SessionTtlSeconds` | `8`, `3600` | Server-side concurrency cap and how long a finished session lingers in the worker's session map. |
| `MonthlyBudgetUsd` + `BudgetEmail` | `0`, `""` | Both required for a budget to be created. Budgets notify; they do not stop anything. |
| `OperatorPrincipalArn` | `""` (account root) | Holding this role's invoke permission is effectively write access to every repository the forge app is installed on. Grant it deliberately. |
| `TranscriptRetentionDays`, `LogRetentionDays` | `90`, `90` | Transcripts may quote proprietary code. |
| Secret names | `cloud-mode/…` | Names only. The stack creates empty shells; values are written out of band. |
| `BuildImage`, `BuildComputeType` | `…aarch64-standard:3.0`, `BUILD_GENERAL1_LARGE` | Must be an ARM image. `SMALL` runs out of disk on a 582 MiB download plus image push. |

## A first bring-up is two passes, not one

**AgentCore validates the ECR pull when the runtime resource is CREATED.** A
runtime pointed at a tag that does not exist yet is therefore a *failed create*
that rolls the whole stack back — not, as an earlier version of this file claimed,
a live runtime reporting a pull error you fix by deploying again. There is no
ordering that avoids this in one pass: `DependsOn` on the repository would not
help, because the repository exists long before an image is in it.

So a bring-up into an empty account is:

| Pass | `CreateRuntime` | What lands |
|---|---|---|
| 1 | `false` | Repository, roles, secret shells, bucket, log group, build project. No runtime. |
| — | — | Write the secrets, then build and push the image. |
| 2 | `true` | The runtime, pointed at a tag that now exists, and the operator role's invoke policy. |

The three runtime outputs (`AgentRuntimeArn`, `AgentRuntimeId`,
`RuntimeEndpointName`) are absent after pass one. Their absence is the signal that
the stack is still half-built — an ARN that resolved to nothing would be worse.

Pass one adds **no** invoke policy to the operator role at all, because that policy
names the runtime's exact ARN. Do not widen it to a `runtime/<name>-*` wildcard to
make one pass work: the exact ARN is what stops that role reaching a second runtime
in the account.

`packaging/agentcore-worker/infra` shape is pinned by
`test/test_agentcore_infra_template.py`, including a walk that fails if a *new*
ungated reference to the runtime lands.

## Where the build gets its source

`BuildSpecPath` defaults to `packaging/agentcore-worker/infra/buildspec.yml`, a
path resolved *inside the cloned source*. So `SourceLocation` must point at a tree
that actually contains `packaging/agentcore-worker` — which a branch that only
exists on your laptop does not. Three ways out:

| Option | `SourceType` / `SourceLocation` | Notes |
|---|---|---|
| **Push the branch** | `GITHUB` / `https://github.com/<owner>/<repo>.git` | Simplest. A public repository clones with no credential; a private one needs an **account-level** GitHub token, imported once with `aws codebuild import-source-credentials`. Check what the account already has: `aws codebuild list-source-credentials`. |
| **Zip the working tree** | `S3` / `<bucket>/<key>.zip` | No push and no token. Zip from the repo root so the paths inside match `BuildSpecPath`, upload it, and give the build role read access to that object. Re-upload for every iteration — the zip is a snapshot, not a branch. |
| **Build locally on arm64** | — | Skip CodeBuild: build `../Dockerfile` on an arm64 daemon (Colima on Apple silicon) and push to the repository from step 5's `PROJECT` output's repository. Costs a 582 MiB local download, which is what the build project exists to avoid. |

`NO_SOURCE` is **not** selectable, and that is not an oversight: CodeBuild requires
an *inline* buildspec when a project has no source, and this project's `BuildSpec`
is a path. A `NO_SOURCE` project built from this template could never run, so the
parameter rejects the combination instead of letting `CreateProject` succeed and
every build fail.

## Deploy sequence (human)

Set your coordinates once:

```bash
PROFILE=<your-admin-profile>
REGION=<your-region>
STACK=<your-stack-name>
SUFFIX=isotest              # empty for the live stack
SOURCE=<see "Where the build gets its source">
```

1. **Resolve the agent artifact and its digest.** Both come from the vendor's own
   release metadata; nothing else can proceed without the pair.

   ```bash
   # The install script names the release channel and the manifest it reads.
   curl -fsSL https://cli.kiro.dev/install | less
   # The manifest carries the version, the per-target archive names and their sha256.
   curl -fsSL https://prod.download.cli.kiro.dev/stable/manifest.json | jq .

   KIRO_URL=https://prod.download.cli.kiro.dev/stable/<version>/kirocli-aarch64-linux-musl.zip
   KIRO_SHA=<the manifest's sha256 for that archive>
   ```

   Prefer an explicit `<version>` over a `latest/` path: `latest/` is not a pin.
   `KiroCliSha256` is what makes the build reproducible either way — the Dockerfile
   runs `sha256sum -c`, so a drifted archive fails the build rather than shipping an
   unreviewed binary. Recompute it yourself with
   `curl -sSL "$KIRO_URL" | shasum -a 256` if you would rather not trust the
   manifest's own field (it is a 582 MiB download).

2. **Validate before deploying** (both are read-only):

   ```bash
   cfn-lint template.yaml
   aws cloudformation validate-template --template-body file://template.yaml \
     --profile "$PROFILE" --region "$REGION"
   ```

3. **Deploy pass one, with no runtime.** `CAPABILITY_IAM` is required: the
   template creates the runtime, operator and build roles. `--disable-rollback`
   leaves a failed resource inspectable instead of deleting the evidence.

   ```bash
   aws cloudformation deploy \
     --template-file template.yaml \
     --stack-name "$STACK" \
     --capabilities CAPABILITY_IAM \
     --disable-rollback \
     --profile "$PROFILE" --region "$REGION" \
     --parameter-overrides \
       CreateRuntime=false \
       ResourceSuffix="$SUFFIX" \
       KiroCliUrl="$KIRO_URL" \
       KiroCliSha256="$KIRO_SHA" \
       SourceLocation="$SOURCE" \
       ImageTagMutability=MUTABLE \
       ImageTag=latest
   ```

4. **Write the secret values.** Four shells exist and are empty. Read the key
   from a file rather than typing it on a command line, so it never lands in
   shell history:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id "cloud-mode/kiro-api-key${SUFFIX:+-$SUFFIX}" \
     --secret-string "$(cat ~/.private/kiro-api-key)" \
     --profile "$PROFILE" --region "$REGION"
   # then the same for gh-app-id, gh-installation-id and gh-app-private-key
   ```

5. **Build and push the image** (in-account; no local Docker needed):

   ```bash
   PROJECT=$(aws cloudformation describe-stacks --stack-name "$STACK" \
     --query "Stacks[0].Outputs[?OutputKey=='ImageBuildProjectName'].OutputValue" \
     --output text --profile "$PROFILE" --region "$REGION")
   BUILD=$(aws codebuild start-build --project-name "$PROJECT" \
     --query 'build.id' --output text --profile "$PROFILE" --region "$REGION")
   aws codebuild batch-get-builds --ids "$BUILD" \
     --query 'builds[0].[buildStatus,currentPhase]' --output text \
     --profile "$PROFILE" --region "$REGION"
   ```

   Confirm the tag really exists before pass two — this is the check that turns a
   rolled-back stack into a clean deploy:

   ```bash
   aws ecr describe-images --repository-name "agentcore-worker${SUFFIX:+-$SUFFIX}" \
     --image-ids imageTag=latest --query 'imageDetails[0].imagePushedAt' \
     --output text --profile "$PROFILE" --region "$REGION"
   ```

6. **Deploy pass two, creating the runtime.** Re-run step 3 with
   `CreateRuntime=true` and every other override unchanged. For anything after a
   first bring-up, set `ImageTag` to the commit-sha tag the build also pushes,
   rather than `latest` — a push does not update a runtime, and a mutable `latest`
   makes it impossible to say later which image a runtime is running.

7. **Read the outputs the client needs:**

   ```bash
   aws cloudformation describe-stacks --stack-name "$STACK" \
     --query 'Stacks[0].Outputs' --output table \
     --profile "$PROFILE" --region "$REGION"
   ```

   `AgentRuntimeArn`, `RuntimeEndpointName` (always `DEFAULT` — AgentCore
   provisions that endpoint itself) and `OperatorRoleArn` are what the local
   client is configured with.

## What a human must do, and an agent must not

Every item here is a mutation of a shared or credential-bearing resource. An
agent session in this repository may read and describe freely; none of these:

- **Create the forge app** and install it on the target repositories, and record
  its app id, installation id and private key. This grants write access to every
  repository it is installed on.
- **Start a build or push an image** (step 5), and delete or repoint an image
  tag.
- **Rotate a credential**, or grant `OperatorPrincipalArn` to a person.
- **Create the VPC, subnets, security groups or firewall** for
  `NetworkMode=VPC`.

## Open items an operator should know about

- **The image size is not yet measured.** The archive is 582 MiB compressed and
  the AgentCore limit is 2 GB. The Dockerfile drops the shell-integration
  binaries, which the local install shows to be one full-size copy per shell, and
  `buildspec.yml` fails the build if the finished image exceeds 2 GB. The first
  in-account build is what turns this from a projection into a number.
- **The artifact is a musl build on a glibc base.** That works when it is
  statically linked. The Dockerfile prints `ldd` output for both binaries so the
  first build log answers it; if a musl loader turns out to be needed, the fix is
  a musl-based stage or `musl` in the base layer.
- **The container smoke test is the real gate** on the `$HOME/.local/bin`
  placement and on `kiro-cli --version`; the in-build checks are diagnostics that
  deliberately do not fail the build.
- **No pass of this template has been deployed yet.** It passes
  `validate-template` and `test/test_agentcore_infra_template.py`, and the
  two-phase sequence follows from AgentCore's create-time ECR validation — but the
  first real deploy is what turns that into an observation. Use
  `--disable-rollback` on it: a rolled-back stack deletes the very resource whose
  status message explains the failure.
