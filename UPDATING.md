# Updating the copied Auto reviewer

## Supported baseline

The initial compatibility target is DeepSeek Harness **0.2.1-rc.3**, commit `1f81c047fc48fa190a683e469daa699857e9afe8`. Updating the snapshot does not by itself make this plugin compatible with another Harness version. Review its public APIs and dependency pins, then run the integration tests before changing the declared compatibility.

[Upstream metadata](<vendor/upstream.json>) records the repository, package version, exact commit, original paths, and SHA-256 hashes. The [complete reviewer snapshot](<vendor/upstream/auto-review.ts>) and [license](<vendor/upstream/LICENSE>) are byte-for-byte Git blobs, including the original plugin lifecycle. They are not runtime modules and must not be edited by hand.

## Local adaptation

[The generator](<scripts/generate-reviewer.mjs>) creates [the runtime reviewer](<src/auto-review.ts>). Do not edit the generated module directly. Its explicit text replacements are the local patch; there is no second hand-maintained reviewer implementation.

The generator retains the upstream first 674 lines except for the module header, unused preset and approval imports, stock plugin exports, the built-in `askUser` helper, and the explicit reasoning-effort adaptation below. In particular, it preserves the full policy text, snapshot construction, source-role reconstruction, native/PTC validation, current provider/model selection, stream parser, risk parser, and structured denial/failure rendering. The stock `apply()` and its preset registration/full-access teardown are excluded entirely.

The pinned official reviewer sends `temperature: 0` but omits `reasoningEffort`; it does not explicitly disable thinking. The plugin requests thinking with high effort by importing `ReasoningEffortId` and sending `reasoningEffort: ReasoningEffortId('high')` through `ctx.llm.stream`. This is the supported `GenerateOptions` field in the pinned LLM API, not a separate `thinking` or `effort` field. The selected provider adapter maps that effort to its model's reasoning controls; the plugin retains the logged provider/model and all other request parameters. A model that does not advertise `high` effort fails closed through the existing reviewer-failure path; the plugin does not silently lower effort.

Two adapter exports replace the stock lifecycle:

- `isAutoReviewCandidate(exec)` matches calls with an agent, excluding only the outer `run_code` transport.
- `reviewTool(ctx, exec, signal)` returns allow, final deny, or cancel. It combines tool and caller cancellation, never asks for approval, and never executes the pending tool. The enclosing plugin owns the popup, downstream delegation, and draining on unload.

The upstream prompt's statement that an allowed action executes with full host access is intentionally unchanged. It gives the reviewer a conservative risk assumption; it is **not** the actual execution policy. This plugin separately requires the session's native read-only or workspace-write confinement. Copying this prompt neither grants full access nor supplies sandbox enforcement. Direct popup authorization skips this reviewer but not the execution policy or other downstream denials.

## Refresh procedure

Run these commands from this repository, with a local upstream Git checkout:

```sh
node scripts/update-upstream.mjs --source ../source
node scripts/generate-reviewer.mjs --check
```

Without `--ref`, the importer uses the currently recorded exact commit, not checkout HEAD. To inspect a candidate update, select its Git ref explicitly:

```sh
node scripts/update-upstream.mjs --source ../source --ref <reviewed-git-ref>
```

The importer resolves the ref to an exact commit, reads the official package version, and imports the source and license with `git show`. It does not build, install, change branches, or write anything in the upstream checkout. Uncommitted upstream edits do not enter the snapshots. Run with the expected repository and inspect the resulting metadata and diff; a Git commit and its matching SHA-256 establish which local bytes were imported, not who authenticated that repository.

The importer writes the selected pristine snapshots and metadata before generation. If a marker, hash, or extraction boundary is incompatible, it exits nonzero without overwriting the existing generated reviewer. This deliberately leaves the candidate snapshot available for review. Restore the previous snapshots or update the explicit generator adaptation; never loosen the checks merely to make a refresh pass.

Before accepting an update:

1. Inspect the complete upstream diff, including prompt changes and stock lifecycle changes that the generator omits. Review any changed assumptions in those omitted sections.
2. Compare the generator's removals and wrapper with the new source. The initial 674-line extraction boundary is an intentional review checkpoint, not a promise that later versions have the same layout.
3. Keep upstream policy/classification changes in the pristine snapshot and generated output. Restrict local changes to the documented adapter and avoid automatic fallbacks for unknown formats.
4. Review the upstream license and update [third-party notices](<THIRD_PARTY_NOTICES.md>) if required.
5. Update [vendor tests](<tests/vendor.spec.ts>) when intentionally adopting a new baseline; they pin the initial commit, version, and complete file length. Do not change these assertions to accept arbitrary versions.
6. Run the repository's typecheck, tests, and build, plus `node scripts/generate-reviewer.mjs --check`. Verify popup no decision → Auto allow/deny, explicit allow → no Auto, cancellation, malformed reviewer output, native calls, PTC inner calls, and sandbox denial. Verify no built-in approval prompt can follow a reviewer denial.
7. Commit snapshots, metadata, generator changes, generated source, tests, and compatibility declarations together.

[Vendor tests](<tests/vendor.spec.ts>) recompute hashes and compare expected generated text without writing files or running a build. They also assert that policy/classification remain intact and the generated module has no stock preset registration or `ask` decision path.
