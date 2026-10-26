# Third-party notices

The dsh-semi-auto project as a whole is distributed under GPL-3.0-only.
The original DeepSeek Harness code retains the MIT grant and attribution below;
including it in this GPLv3 project does not replace its upstream license.

## DeepSeek Harness Auto reviewer

This project includes a complete source snapshot of the official DeepSeek Harness Auto reviewer and a mechanically adapted runtime derivative.

- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- Version: `0.2.1-rc.3`
- Commit: `1f81c047fc48fa190a683e469daa699857e9afe8`
- Original source: `packages/experimental/auto-review/src/index.ts`
- Copyright: **Copyright (c) 2026 DeepSeek**
- License: **MIT**; the complete original notice and license are preserved in [vendor/upstream/LICENSE](<vendor/upstream/LICENSE>).
- Pristine source: [vendor/upstream/auto-review.ts](<vendor/upstream/auto-review.ts>)
- Adapted source: [src/auto-review.ts](<src/auto-review.ts>)

The local derivative replaces stock preset registration and lifecycle with a callable review adapter and removes the built-in human-approval fallback. Policy, classification, history reconstruction, parsing, and denial details remain upstream code. [UPDATING.md](<UPDATING.md>) describes the exact transformation, hashes, update procedure, and execution-policy distinction.

These notices apply to the copied source and generated derivative. Other installed dependencies retain their own licenses and notices.
