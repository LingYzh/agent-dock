# Native long-session switching acceptance

- The user reported that selecting older long Agent Dock sessions displayed loading or replayed old events before reaching the latest content.
- Selection changes now cancel the previous UI synchronization request, reject stale results/errors, and request a fresh tail window. A four-entry cache retains at most 200 compact events / 256 KiB per session. Cached content cannot authorize input or approvals before fresh state confirmation.
- Recent synchronization resets to the newest page when missed updates exceed one event/byte page. Explicit backwards history and legacy forward clients keep their existing contracts.
- Tool tests exposed a second issue: a tool update could lose its title/kind when its initial event preceded the visible window. Compact projection now restores only actual preceding static metadata and carries it through subsequent updates. Output, status, sequence references, raw journals and earlier-page chronology remain intact.
- After a full desktop restart, the real current-chat MCP App loaded the patched frontend. Two synthetic persisted archives, each with 2,000 turns / 6,000 events, opened at their latest turn in observed 210 / 175 ms. Cached switches observed 54–114 ms without the loading placeholder. After adding 1,000 turns to one fixture, it reached turn 3,000 in 220 ms with 198 / 9,000 events loaded.
- Native tool coverage used eight synthetic tool calls per fixture: six successes grouped together, interleaved assistant text, then one failure and one continued success. Groups initially remained collapsed; a 594,021-character output loaded in 24,576-character pages. Different sessions retained their own output. A further 250-update tool whose initial event was outside the latest 200 events retained its label/type and final result, including through cached selection.
- The fixtures were removed from the live registry and retained only as local ignored evidence. All 30 original journal files matched their pre-test hashes, and the original selection was restored. No model requests, actual tool execution, or fresh provider permission callbacks were used in these UI fixtures.
- The fix is installed locally as a reversible runtime overlay. Source and generated checksums are updated; no commit, tag or GitHub release was made in this acceptance task.

## Release preparation

- The user subsequently authorized committing, publishing and updating the local installation. Prepare `1.1.0-beta.4` with the accepted switching/tool fixes, the desktop inventory refresh instructions, and pinned-tag upgrade handling in the installer. Replace the local runtime overlay with the published package while preserving the shared state.
