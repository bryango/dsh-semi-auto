# Updating the copied Auto reviewer

## 0.3.0 behavior and upgrade

Version 0.3.0 is a native full-access approval broker, not a reviewer for ordinary tool calls.
Ordinary calls produce no plugin popup or model review.
Network operations, remote tool effects, and workspace deletions therefore receive no model review from this plugin unless the native tool requests full access.
The native tool decides when full access is required; the broker does not classify commands to create extra approvals.
The official Auto plugin, if selected, retains its own behavior.

Only native reasons with the rc.3/rc.5 shared `approveEscalation` helper's exact prefix,
`escalate sandbox to danger-full-access: `, followed by a nonempty justification enter the broker.
This also covers implicit helper requests from `plugin_manager`, without requiring escalation fields in the tool schema or arguments.
The supported approval API exposes no structured target mode or scope.
This reason-prefix adapter is version-bound, not a generic detector for every third-party request.
Unknown reasons, general asks, and read-only → workspace-write requests delegate to the native answerers with `next()`.
Native `never` still rejects before any answerer.

The plugin does not change persistent sandbox or approval settings, and does not reject ordinary calls in full access or native Auto mode.
External subagent provider registration is allowed; their own permissions and approval protocols remain outside this broker.
The popup itself still requires the local subprocess provider.
The composer toggle applies only to newly admitted calls; pending approvals retain their original path.
Unloading the entry cancels and waits for pending popup/review work only.
It neither cancels nor joins an authorized tool body, so a granted `plugin_manager` call can unload or reload the plugin without waiting on itself.

Stop tool work, disable the old entry, and wait for its cleanup before replacing and enabling 0.3.0.
A popup that already uses empty stdout → Auto review, `allow` → direct authorization, and `deny` → rejection can display the new complete JSON context without a binary upgrade.
Do not reuse an older binary where `allow` meant Auto review.
For migrations from the fixed-`never` 0.1.0 implementation, let the old entry restore its managed policies first;
manually select the intended native preset for older persisted sessions that still contain `never`.
The new plugin never changes those restrictions to `ask` automatically.

## Supported baseline

The current development and test baseline is DeepSeek Harness **0.2.1-rc.5**, commit `b830ec950faba0a46dda564be3e2d854afed94f1`.
The declared engine and service peers retain support for **0.2.1-rc.3**; development service identities and their peer closure are pinned to rc.5 to prevent mixed branded types.
The rc.3 → rc.5 review found no source changes to the reviewed agent, tools, approval, sandbox, subagent, subprocess, hook-protocol, hooks, Connection RPC, or remote APIs; the composer slot is unchanged.
The official reviewer and license snapshots are byte-for-byte unchanged from rc.3; only their recorded release and commit advance.
Updating the snapshot does not by itself make this plugin compatible with another Harness version.
Review its public APIs and published dependency types, then run the integration tests before changing the declared compatibility.

[Upstream metadata](<vendor/upstream.json>) records the repository, package version, exact commit, original paths, and SHA-256 hashes. The [complete reviewer snapshot](<vendor/upstream/auto-review.ts>) and [license](<vendor/upstream/LICENSE>) are byte-for-byte Git blobs, including the original plugin lifecycle. They are not runtime modules and must not be edited by hand.

## Local adaptation

[The generator](<scripts/generate-reviewer.mjs>) creates [the runtime reviewer](<src/auto-review.ts>). Do not edit the generated module directly. Its explicit text replacements are the local patch; there is no second hand-maintained reviewer implementation.

The generator uses the upstream first 674 lines with explicit local adaptations:
the module header, unused preset and approval imports, stock plugin exports, the built-in `askUser` helper,
the request options, and optional native-approval context described below.
It preserves the complete official policy text, source-role reconstruction, native/PTC validation,
current provider/model selection, stream parser, risk parser, and structured denial/failure rendering.
The stock `apply()` and its preset registration/full-access teardown are excluded entirely.

The pinned official reviewer sends `temperature: 0` and omits `reasoningEffort`; it does not explicitly disable thinking.
The plugin drops the fixed `temperature` because some provider adapters reject the parameter outright,
and requests thinking with low effort by importing `ReasoningEffortId` and sending `reasoningEffort: ReasoningEffortId('low')` through `ctx.llm.stream`.
This is the supported `GenerateOptions` field in the pinned LLM API, not a separate `thinking` or `effort` field.
The selected provider adapter maps that effort to its model's reasoning controls and applies its own default sampling;
the plugin retains the logged provider/model and every other request parameter.
A model that does not advertise `low` effort fails closed through the existing reviewer-failure path;
the plugin does not silently substitute another effort.

Two adapter exports replace the stock lifecycle:

- `isAutoReviewCandidate(exec)` retains the official candidate helper, excluding only the outer `run_code` transport.
  It does not decide broker admission; ordinary native and inner PTC calls do not invoke the reviewer.
- `reviewTool(ctx, exec, signal, approval?)` returns allow, final deny, or cancel.
  It combines tool and caller cancellation, never asks for approval, and never executes the pending tool.
  The optional `FullAccessApproval` supplies the requested mode and complete native reason as factual context.
  A separate `NATIVE_PERMISSION_REQUEST` partition is added to the review input without changing the official policy or original tool arguments.
  The broker calls this adapter only after popup no decision for a matched native full-access request,
  including an outer `run_code` request when applicable.
  The enclosing plugin owns the popup and drains pending authorization work, not authorized tool bodies, on unload.

The same optional approval context reaches the popup through `PopupRequest.approval`.
Its `tool_input` is `{ "native_approval": { "requestedMode": "danger-full-access", "reason": "<complete native reason>" }, "tool_arguments": <original arguments> }`.
The existing binary can display this complete JSON without understanding the wrapper fields.
The wrapper changes display and review context only; actual execution arguments remain unchanged.

The upstream prompt's full-host risk assumption is intentionally unchanged.
Copying this prompt neither grants full access nor supplies sandbox enforcement.
Native tools and permission settings determine actual execution scope;
a native `allowed-once` grant can permit the operation outside its original sandbox without changing the session's long-term mode.
Direct popup authorization skips this reviewer, not other downstream denials.

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
