// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project-agnostic validation gate for the Cloud Mode worker.
 *
 * The integration loop runs a shell command in the resolved worktree BEFORE it
 * pushes; a zero exit means "safe to push". Two layers:
 *
 *   1. Explicit override — `CLOUD_MODE_VALIDATE_CMD` (set at deploy time or per
 *      runtime). When present it is used verbatim; the operator owns it.
 *
 *   2. Auto-detected default — when no override is set, we inspect the marker
 *      files at the worktree root and synthesise a sensible install + verify
 *      command for the detected ecosystem. This lets the same worker validate
 *      any kind of project without per-repo configuration.
 *
 * Design principles:
 *   - Validate what the runtime image can (Node via corepack: pnpm/yarn/npm/bun).
 *   - Never block on what it cannot: if a project's toolchain is not on PATH
 *     (e.g. a Python/Rust/Go repo on a Node-only image), the generated command
 *     announces the skip with `SKIP_MARKER`, and `makeValidator` FAILS CLOSED on
 *     it — a gate that could not run is not a gate that passed. Operators who
 *     accept that risk set `CLOUD_MODE_ALLOW_UNVALIDATED=1`; operators who want
 *     a hard gate set `CLOUD_MODE_VALIDATE_CMD` (or extend the image).
 *   - Prefer fast, service-free checks (install + lint/typecheck/build + unit
 *     tests via `--if-present`) so the gate rarely needs a database/browser.
 *   - The command is REPOSITORY-SUPPLIED code and therefore untrusted: it runs
 *     through sandbox.mjs (separate OS user where available, always a scrubbed
 *     environment), so a hostile `pretest` script cannot read the runtime
 *     credentials or the GitHub token (threat model T-006 / mitigation M-012).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describeSandbox, runUntrusted, sandboxState } from "./sandbox.mjs";

/**
 * Only run a step when its tool is on PATH; otherwise print a skip note and
 * pass. Used for ecosystems whose toolchain may be absent from the image.
 *
 * The note is machine-detectable (`SKIP_MARKER`) so `makeValidator` can turn a
 * skipped ecosystem into a *failed* gate rather than a silent pass — a skipped
 * gate is not a passing gate (threat model M-008, open question 4).
 */
export const SKIP_MARKER = "[cloud-mode] validation skipped:";
function guard(tool, body, ecosystem) {
	return (
		`if command -v ${tool} >/dev/null 2>&1; then\n${body}\n` +
		`else echo "${SKIP_MARKER} '${tool}' not available for ${ecosystem} project"; fi`
	);
}

/**
 * Run the common verification scripts for a Node package manager that supports
 * \`run --if-present\` (npm, pnpm). Missing scripts are skipped, not errors.
 *
 * `format` runs FIRST in write mode (e.g. prettier --write) so a clean merge can
 * never land unformatted — integrateToMain commits the normalized tree before
 * pushing. Then the checks run. This closes the gap where formatting-only issues
 * slipped past the worker gate and only broke CI's `format:check`.
 */
function nodeScripts(pm) {
	return ["format", "lint", "typecheck", "build", "test"]
		.map((s) => `${pm} run --if-present ${s}`)
		.join(" && ");
}

/**
 * Pure planner: given the set of marker filenames present at the repo root,
 * return the shell command that validates the tree, or `null` when the project
 * type is unknown (⇒ caller treats it as a no-op pass).
 *
 * Exported for unit testing without touching the filesystem.
 */
export function planValidation(present) {
	const has = (f) => present.has(f);

	// ── Node.js ────────────────────────────────────────────────────────────
	if (has("package.json")) {
		// corepack (bundled with Node ≥16) provisions the pinned pnpm/yarn.
		const enable = "corepack enable >/dev/null 2>&1 || true";
		if (has("pnpm-lock.yaml")) {
			return `${enable}\npnpm install --frozen-lockfile && ${nodeScripts("pnpm")}`;
		}
		if (has("yarn.lock")) {
			// Berry uses --immutable; classic uses --frozen-lockfile. Try both.
			return (
				`${enable}\n(yarn install --immutable || yarn install --frozen-lockfile) && ` +
				`(yarn run --if-present build) && (yarn run --if-present test)`
			);
		}
		if (has("bun.lockb")) {
			return guard(
				"bun",
				"  bun install --frozen-lockfile && bun run --if-present build && bun run --if-present test",
				"bun",
			);
		}
		if (has("package-lock.json") || has("npm-shrinkwrap.json")) {
			return `npm ci && ${nodeScripts("npm")}`;
		}
		// No lockfile: install without the strict lockfile check.
		return `npm install --no-audit --no-fund && ${nodeScripts("npm")}`;
	}

	// ── Python ─────────────────────────────────────────────────────────────
	if (has("pyproject.toml") && has("poetry.lock")) {
		return guard("poetry", "  poetry install --no-interaction && poetry run pytest -q || true", "python/poetry");
	}
	if (has("uv.lock")) {
		return guard("uv", "  uv sync --frozen && uv run pytest -q || true", "python/uv");
	}
	if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
		return guard(
			"python3",
			"  python3 -m pip install -e . 2>/dev/null || python3 -m pip install -r requirements.txt 2>/dev/null || true\n" +
				"  if command -v pytest >/dev/null 2>&1; then pytest -q; fi",
			"python",
		);
	}

	// ── Rust ───────────────────────────────────────────────────────────────
	if (has("Cargo.toml")) {
		return guard("cargo", "  cargo build --locked && cargo test --locked", "rust");
	}

	// ── Go ─────────────────────────────────────────────────────────────────
	if (has("go.mod")) {
		return guard("go", "  go build ./... && go test ./...", "go");
	}

	// ── JVM ────────────────────────────────────────────────────────────────
	if (has("pom.xml")) {
		return guard("mvn", "  mvn -B -q verify", "java/maven");
	}
	if (has("build.gradle") || has("build.gradle.kts")) {
		return guard("gradle", "  ./gradlew build || gradle build", "java/gradle");
	}

	// ── Ruby ───────────────────────────────────────────────────────────────
	if (has("Gemfile")) {
		return guard("bundle", "  bundle install && (bundle exec rake test || bundle exec rspec || true)", "ruby");
	}

	// Unknown ecosystem → cannot validate; caller no-ops (pass).
	return null;
}

/** Marker files planValidation() looks for, so we only stat what matters. */
const MARKERS = [
	"package.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pyproject.toml",
	"poetry.lock",
	"uv.lock",
	"requirements.txt",
	"setup.py",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
];

/** Detect the validation command for a worktree, or null if none applies. */
export function detectValidateCommand(worktree) {
	const present = new Set(MARKERS.filter((f) => existsSync(join(worktree, f))));
	return planValidation(present);
}

/**
 * Build the validator the integration loop calls before pushing.
 *   - `CLOUD_MODE_VALIDATE_CMD` set  → use it verbatim (operator override).
 *   - unset                          → auto-detect from the worktree.
 *   - nothing detected / toolchain absent → FAIL CLOSED by default.
 *
 * Fail-closed is the point: the validation gate is what replaced human review of
 * the diff, so "we could not check" must not read as "the check passed". An
 * unknown ecosystem or a missing toolchain therefore aborts delivery with an
 * actionable message (add the toolchain to the image, or set
 * `CLOUD_MODE_VALIDATE_CMD`). Operators who knowingly accept an ungated run set
 * `CLOUD_MODE_ALLOW_UNVALIDATED=1`, which restores the old logged-pass
 * behaviour and marks the result `skipped` so events and logs can tell the
 * difference (threat model M-008 / Test-020).
 */
export function makeValidator(worktree, { log } = {}) {
	const override = process.env.CLOUD_MODE_VALIDATE_CMD?.trim();
	const allowUnvalidated = /^(1|true|yes)$/i.test(process.env.CLOUD_MODE_ALLOW_UNVALIDATED ?? "");
	const cmd = override || detectValidateCommand(worktree);
	if (!cmd) {
		const reason =
			"no validation command could be determined for this project (unknown ecosystem). " +
			"Set CLOUD_MODE_VALIDATE_CMD, or add the project's toolchain to the worker image.";
		if (allowUnvalidated) {
			log?.(`[cloud-mode] validation gate SKIPPED (CLOUD_MODE_ALLOW_UNVALIDATED=1): ${reason}`);
			return async () => ({ ok: true, skipped: true, output: `${SKIP_MARKER} ${reason}` });
		}
		log?.(`[cloud-mode] validation gate UNAVAILABLE — failing closed: ${reason}`);
		return async () => ({ ok: false, unavailable: true, output: `validation gate unavailable: ${reason}` });
	}
	log?.(`[cloud-mode] validation gate (${override ? "override" : "auto-detected"}):\n${cmd}`);
	log?.(`[cloud-mode] validation gate sandbox: ${describeSandbox(sandboxState())}`);
	return async () => {
		const { ok, output } = await runUntrusted(cmd, { cwd: worktree });
		if (!ok) return { ok: false, output };
		// A command that ran green but only *because* a step was skipped is not a
		// pass either — the guarded steps announce themselves with SKIP_MARKER.
		if (output?.includes(SKIP_MARKER)) {
			const skipped = output
				.split("\n")
				.filter((l) => l.includes(SKIP_MARKER))
				.join("; ");
			if (allowUnvalidated) {
				log?.(`[cloud-mode] validation gate passed with SKIPPED steps (allowed): ${skipped}`);
				return { ok: true, skipped: true, output };
			}
			log?.(`[cloud-mode] validation gate had SKIPPED steps — failing closed: ${skipped}`);
			return {
				ok: false,
				unavailable: true,
				output:
					`validation gate incomplete — a required toolchain is missing from the worker image (${skipped}). ` +
					`Add it to worker/Dockerfile, pin CLOUD_MODE_VALIDATE_CMD, or set CLOUD_MODE_ALLOW_UNVALIDATED=1 ` +
					`to accept an unvalidated delivery.\n\n${output}`,
			};
		}
		return { ok: true, output };
	};
}
