// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the project-agnostic validation planner (worker/validate.mjs).
 *
 * `planValidation` is pure — it maps the set of marker files present at a repo
 * root to the shell command that validates that ecosystem (or null when the
 * project type is unknown). We assert the package-manager selection precedence
 * and the graceful-skip guards, plus the env-override behaviour of
 * `makeValidator`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planValidation, detectValidateCommand, makeValidator, SKIP_MARKER } from "../validate.mjs";

const set = (...files) => new Set(files);

test("Node: pnpm-lock.yaml selects pnpm with a frozen install", () => {
	const cmd = planValidation(set("package.json", "pnpm-lock.yaml"));
	assert.match(cmd, /corepack enable/);
	assert.match(cmd, /pnpm install --frozen-lockfile/);
	assert.match(cmd, /pnpm run --if-present test/);
	assert.doesNotMatch(cmd, /npm ci/);
});

test("Node: package-lock.json selects npm ci", () => {
	const cmd = planValidation(set("package.json", "package-lock.json"));
	assert.match(cmd, /npm ci/);
	assert.match(cmd, /npm run --if-present build/);
});

test("Node: yarn.lock selects yarn (immutable or frozen)", () => {
	const cmd = planValidation(set("package.json", "yarn.lock"));
	assert.match(cmd, /yarn install --immutable \|\| yarn install --frozen-lockfile/);
});

test("Node: no lockfile falls back to npm install (not ci)", () => {
	const cmd = planValidation(set("package.json"));
	assert.match(cmd, /npm install --no-audit --no-fund/);
	assert.doesNotMatch(cmd, /npm ci/);
});

test("pnpm wins over an also-present package-lock.json (monorepo precedence)", () => {
	const cmd = planValidation(set("package.json", "pnpm-lock.yaml", "package-lock.json"));
	assert.match(cmd, /pnpm install --frozen-lockfile/);
	assert.doesNotMatch(cmd, /npm ci/);
});

test("Python/poetry is guarded so a missing toolchain skips instead of failing", () => {
	const cmd = planValidation(set("pyproject.toml", "poetry.lock"));
	assert.match(cmd, /command -v poetry/);
	assert.match(cmd, /validation skipped/);
	assert.match(cmd, /poetry install/);
});

test("Rust and Go are detected and guarded", () => {
	assert.match(planValidation(set("Cargo.toml")), /command -v cargo[\s\S]*cargo test --locked/);
	assert.match(planValidation(set("go.mod")), /command -v go[\s\S]*go test \.\/\.\.\./);
});

test("unknown project type yields null (caller no-ops)", () => {
	assert.equal(planValidation(set("README.md")), null);
	assert.equal(planValidation(set()), null);
});

test("detectValidateCommand reads real marker files from a worktree", () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-validate-"));
	try {
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "pnpm-lock.yaml"), "");
		assert.match(detectValidateCommand(dir), /pnpm install --frozen-lockfile/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("makeValidator: CLOUD_MODE_VALIDATE_CMD overrides auto-detection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-validate-"));
	const prev = process.env.CLOUD_MODE_VALIDATE_CMD;
	try {
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "pnpm-lock.yaml"), "");
		process.env.CLOUD_MODE_VALIDATE_CMD = "true";
		const logs = [];
		const validate = makeValidator(dir, { log: (m) => logs.push(m) });
		const res = await validate();
		assert.equal(res.ok, true);
		assert.match(logs.join("\n"), /override/);
	} finally {
		if (prev === undefined) delete process.env.CLOUD_MODE_VALIDATE_CMD;
		else process.env.CLOUD_MODE_VALIDATE_CMD = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

// Superseded by "unknown project type fails closed" below: an unknown ecosystem
// used to be a silent pass, which meant a delivery could land with no gate at
// all. It is now a hard failure unless CLOUD_MODE_ALLOW_UNVALIDATED is set
// (threat model M-008 / Test-020).
test("makeValidator: unknown project type is no longer a silent pass", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-validate-"));
	const prev = process.env.CLOUD_MODE_VALIDATE_CMD;
	const prevAllow = process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
	try {
		delete process.env.CLOUD_MODE_VALIDATE_CMD;
		delete process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
		const validate = makeValidator(dir);
		const res = await validate();
		assert.equal(res.ok, false);
		assert.equal(res.unavailable, true);
	} finally {
		if (prev !== undefined) process.env.CLOUD_MODE_VALIDATE_CMD = prev;
		if (prevAllow !== undefined) process.env.CLOUD_MODE_ALLOW_UNVALIDATED = prevAllow;
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Threat model Test-012 / Test-013 at the gate: the validation command is
 * REPOSITORY-SUPPLIED code. It must not be able to read AWS credentials, the
 * loopback credential-broker coordinates, or the GitHub installation token.
 */
test("makeValidator: repo-supplied code sees no credentials (T-006/T-011/T-012)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-validate-"));
	const saved = { ...process.env };
	try {
		Object.assign(process.env, {
			CLOUD_MODE_VALIDATE_CMD: "env; echo \"gh=${GH_TOKEN:-none}\"; echo \"aws=${AWS_SECRET_ACCESS_KEY:-none}\"",
			AWS_ACCESS_KEY_ID: "ASIALEAKCANARY",
			AWS_SECRET_ACCESS_KEY: "secretleakcanary",
			AWS_SESSION_TOKEN: "sessionleakcanary",
			AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:1/agent-credentials",
			AWS_CONTAINER_AUTHORIZATION_TOKEN: "brokerleakcanary",
			GH_TOKEN: "ghs_leakcanary",
		});
		const res = await makeValidator(dir)();
		assert.equal(res.ok, true);
		for (const canary of [
			"ASIALEAKCANARY",
			"secretleakcanary",
			"sessionleakcanary",
			"brokerleakcanary",
			"ghs_leakcanary",
		]) {
			assert.doesNotMatch(res.output, new RegExp(canary), `${canary} leaked into the validation gate`);
		}
		assert.match(res.output, /gh=none/);
		assert.match(res.output, /aws=none/);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Threat model Test-020 / open question 4: a gate that could not run must not
 * read as a gate that passed. The validation gate is what replaced human review
 * of the diff, so "unknown project type" and "toolchain missing from the image"
 * both have to FAIL, loudly and actionably — unless the operator explicitly
 * accepts an unvalidated delivery.
 */
test("makeValidator: unknown project type fails closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-validate-"));
	const saved = { ...process.env };
	try {
		delete process.env.CLOUD_MODE_VALIDATE_CMD;
		delete process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
		const logs = [];
		const res = await makeValidator(dir, { log: (m) => logs.push(m) })();
		assert.equal(res.ok, false, "an ungated tree must not be pushable");
		assert.equal(res.unavailable, true);
		assert.match(res.output, /validation gate unavailable/);
		assert.match(res.output, /CLOUD_MODE_VALIDATE_CMD/);
		assert.match(logs.join("\n"), /failing closed/);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("makeValidator: CLOUD_MODE_ALLOW_UNVALIDATED marks the result skipped, not passed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-validate-"));
	const saved = { ...process.env };
	try {
		delete process.env.CLOUD_MODE_VALIDATE_CMD;
		process.env.CLOUD_MODE_ALLOW_UNVALIDATED = "1";
		const res = await makeValidator(dir)();
		assert.equal(res.ok, true);
		assert.equal(res.skipped, true, "a skipped gate must stay distinguishable from a pass");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("makeValidator: a missing toolchain inside a green run still fails closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-validate-"));
	const saved = { ...process.env };
	try {
		// Simulate validate.mjs's guarded skip: exit 0 but announce the skip.
		process.env.CLOUD_MODE_VALIDATE_CMD = `echo "${SKIP_MARKER} 'cargo' not available for rust project"`;
		delete process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
		const res = await makeValidator(dir)();
		assert.equal(res.ok, false, "a green exit code with a skipped step is not a pass");
		assert.match(res.output, /validation gate incomplete/);
		assert.match(res.output, /worker\/Dockerfile/);

		process.env.CLOUD_MODE_ALLOW_UNVALIDATED = "1";
		const allowed = await makeValidator(dir)();
		assert.equal(allowed.ok, true);
		assert.equal(allowed.skipped, true);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	}
});
