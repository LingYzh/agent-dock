# Public beta architecture

- Root contains installation/release documentation and the Git marketplace catalog. plugin/ is the self-contained source loaded by the Codex plugin cache.
- Public MCP configuration uses portable Agent Plugins `plugin.json` and `mcp.json`, Node, and `${PLUGIN_ROOT}/bootstrap.mjs`. The desktop build tested left this placeholder literal in legacy `.mcp.json`, which failed before startup when used as `cwd` and failed to load the script when used as argv. The portable manifest expands it; bootstrap resolves its files relative to its own URL. Do not add a developer workstation path to the package.
- The portable stdio schema does not accept Codex-specific timeouts. Prepare the runtime before first discovery via `install.ps1` to keep dependency downloads outside the host startup deadline.
- Release acceptance for the plugin manifest must use the desktop app-server's MCP discovery and UI resource read against a fresh marketplace install. A direct SDK connection with an already resolved path misses manifest expansion errors. Native discovery and the visible current-chat sidebar are separate checks.
- The synthetic prompt timeout regression handshakes with its fixture first. Its short deadline is for prompt progress, not the time Windows takes to start Node.
- Bootstrap discovers a user-local home (or explicit custom location), verifies an allowlisted runtime manifest, installs pinned production dependencies from the public npm registry, and starts MCP from a versioned runtime directory. Diagnostic output never enters MCP stdout.
- Per-user state is independent of checkout/cache/runtime versions. An explicit installer may write a small user-local locator so custom-drive installations remain discoverable without system environment changes.
- Provider settings belong to the installer. AGY uses native executable discovery; Claude uses its adapter and standard authentication/configuration. The source contains no subscription credentials or author configuration.
- Default checks use synthetic transports. Clean-profile testing prepares dependencies in an isolated path and verifies protocol startup without Agent accounts or prompts. Real provider/model access and native desktop UI acceptance are separate evidence boundaries.

## Beta verification

- Synthetic protocol, permission, recovery, timeline, link and portability checks pass.
- Empty-user-profile bootstrap passes with no AGY executable, no publisher login/CC Switch settings and no model prompts. Custom paths containing spaces and Unicode, idempotent installation, authenticated bridge access and MCP tools/resources were checked.
- PowerShell environment checking/runtime preparation and isolated local marketplace installation pass. Real provider execution and native desktop rendering are separate acceptance steps.

## Long sessions and archives

- New panels opt into recent-first `panel_sync`; `after` follows live events and `before` loads one older page on demand. Keep these cursors separate, preserve the scroll anchor when prepending, and summarize usage from the complete bridge history. Older panels can still use forward sync. After upgrading, the running bridge must also be replaced for the new protocol and close behavior.
- Archive is a local durable state transition for inactive sessions. Append and flush the close event before mutating memory, then request optional ACP cleanup with a short deadline and stop the owned child. Keep a write failure visible and retryable. Startup reads intact journals without rewriting them; only torn trailing records are truncated.
- Panel height follows the host viewport in fullscreen. Keep list/detail scrolling independent, and establish a containing block for the absolute screen-reader text in each list row so a long archive cannot enlarge document scroll height.
- Regression coverage: isolated 3,600-event ACP fixture for recent/backwards paging, full usage, archive timeout and refusal, disk failure, history persistence and repeat close. An isolated Chromium iframe with a mock MCP host covered 75 archived rows, nested scroll, scroll anchor, viewport sizes 850×1100 / 390×520 / 360×400 and initialization ordering. This does not reproduce the original remote installation.

## Bridge and ACP process lifetime

- Windows stop operates on the running ACP child owned by this bridge and its process tree. Do not kill by image name or try to claim historical orphans without ownership evidence. The persisted close transition remains independent of provider cleanup.
- A bridge started by the launcher has an authenticated loopback lease per attached MCP host. The MCP stdin EOF releases its lease; abrupt MCP exit also closes the socket. Keep the shared bridge while at least one lease remains, then allow five seconds for a reconnect before stopping providers and exiting. The standalone service and already running legacy bridges do not have this lease policy.
- Synthetic Windows regression starts two MCP hosts and two ACP process trees. Archiving after an already-closed provider response removes the owned helper; disconnecting one host leaves the other alive. Killing the final MCP host removes the bridge and remaining ACP tree while preserving both saved records.
- A separate local Windows smoke used real `agy acp` with two empty sessions in isolated bridge state. All 9 observed descendants exited on archive and all 10 observed descendants exited on final MCP disconnect. Both session records persisted; no model prompts were sent. This did not replace the live desktop installation.

## Shared ACP sessions

- Each bridge has independent Antigravity and Claude ACP pools, one adapter process per provider. Initialize once, bind each native session ID to its own client handle, and route output, replay, approvals and prompt inactivity timers per session. Serialize new-session setup to bind early notifications without blocking existing prompt streams. Never answer a permission request from another session's handle.
- Session release closes only that native session. Stop the adapter when no handles remain, the bridge exits, or the connection fails. An unconfirmed timed-out turn can retire the shared connection rather than leave hidden work running. Persist shared disconnects and preserve histories; do not replay prompts. Each provider has its own dedicated-process override.
- The synthetic integration exercises concurrent creation, early updates, two simultaneous approval queues, cross-session denial, cancellation, archive, abrupt disconnect, and replacement connection. An isolated real AGY run with Gemini 3.8 Flash / High confirmed one process, two correct replies to concurrent submissions, a second run cancelling only one turn, and process release after the last archive. This does not change the currently installed desktop plugin.
- Claude ACP 0.101.0 shares the adapter but manages its CLI subprocesses per session. An isolated run with the user's existing Claude configuration confirmed one adapter, concurrent replies, cancellation and archive isolation, and exit after the final archive. When an empty Claude session is recreated on recovery, remove its old native-ID mapping; a synthetic regression verifies late updates cannot reach the replacement.

## Bounded timeline, archive diagnostics and worktrees

- Modern panels opt into compact tool updates; only timeline fields and short text previews enter the sync pages. Keep raw events in the journal. The app-only `panel_detail` reads a single event/source in bounded, Unicode-safe pages. Pending approvals still include their complete tool data. Legacy panel sync remains compatible.
- Virtual rows use stable event identities, measured heights and a pinned prepend anchor. Retain disclosure state when rows leave the viewport. Diagnostics show the durable local close separately from optional ACP close and process cleanup; record the latter outcomes without making a saved archive contingent on them.
- Worktree is an explicit `worktreeRepo` argument or opt-in setup checkbox. Resolve a local repository and create from its committed HEAD with an independent branch, under state/work/worktrees. Reuse the native session's cwd on recovery. Archive must not remove a worktree, branch or uncommitted edits. Preparing the model catalog in the dialog does not create a worktree.
- Regression coverage: compact tool and raw event round trips, archive timeout/error and shared-process retention, two isolated Git checkouts plus unchanged default mode, and Chromium mock-host checks for lazy detail, bounded mounted rows, prepend anchor, independent scrolling and worktree opt-in. Real desktop deployment and provider filesystem behavior are separate checks.
