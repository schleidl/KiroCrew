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
| `KiroCliUrl` | URL of the aarch64 musl kiro-cli release archive. No default on purpose: the vendor's release host embeds a region and this repository is public. Take it from the operator's WP1 spike notes. |
| `KiroCliSha256` | `curl -sSL "$KiroCliUrl" \| shasum -a 256`. The Dockerfile refuses to build without it, so a rebuild can only ship the reviewed binary. |
| `SourceLocation` | Repository CodeBuild clones to find the Dockerfile. Omit only with `SourceType=NO_SOURCE`. |

Worth setting deliberately:

| Parameter | Default | Notes |
|---|---|---|
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

## Deploy sequence (human)

Set your coordinates once:

```bash
PROFILE=<your-admin-profile>
REGION=<your-region>
STACK=<your-stack-name>
SUFFIX=isotest              # empty for the live stack
SOURCE=<repo CodeBuild clones>
KIRO_URL=<aarch64 musl archive url from the WP1 spike notes>
```

1. **Pin the agent artifact.** Nothing else can proceed without this digest.

   ```bash
   KIRO_SHA=$(curl -sSL "$KIRO_URL" | shasum -a 256 | cut -d' ' -f1)
   echo "$KIRO_SHA"
   ```

2. **Validate before deploying** (both are read-only):

   ```bash
   cfn-lint template.yaml
   aws cloudformation validate-template --template-body file://template.yaml \
     --profile "$PROFILE" --region "$REGION"
   ```

3. **Deploy the stack.** `CAPABILITY_IAM` is required: the template creates the
   runtime, operator and build roles.

   ```bash
   aws cloudformation deploy \
     --template-file template.yaml \
     --stack-name "$STACK" \
     --capabilities CAPABILITY_IAM \
     --profile "$PROFILE" --region "$REGION" \
     --parameter-overrides \
       ResourceSuffix="$SUFFIX" \
       KiroCliUrl="$KIRO_URL" \
       KiroCliSha256="$KIRO_SHA" \
       SourceLocation="$SOURCE" \
       ImageTagMutability=MUTABLE \
       ImageTag=latest
   ```

   The runtime is created in the same pass and will report a pull failure until
   step 5 has pushed an image. That is expected on a first bring-up; deploy the
   stack again after the push, or push first with `ImageTag` pointing at an image
   that already exists.

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

6. **Point the runtime at the pushed image.** A push does not update a runtime.
   Re-run the step-3 deploy with `ImageTag` set to the tag you want live — the
   build also pushes a commit-sha tag, which is the one to use for anything but a
   first bring-up.

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

- **Deploy or update the stack** (steps 3 and 6), including any
  `cloudformation deploy`, `create-stack`, `update-stack` or `delete-stack`.
- **Write any secret value** (step 4). Creating the empty shell is the
  template's job; `put-secret-value` is a human's. The Kiro API key in
  particular must never pass through a chat transcript — read it from a file.
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
