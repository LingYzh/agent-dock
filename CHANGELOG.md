# Changelog

## 1.1.0-beta.3 — 2026-11-09

- Fix Windows desktop discovery of Agent Dock. Use portable Agent Plugins manifests so Codex expands the installed path before starting Node. The launcher does not need a working directory override.
- Document runtime preparation before opening the panel on a fresh installation, so npm downloads do not compete with the host's startup deadline.

## 1.1.0-beta.2 — 2026-11-09

- Archive inactive sessions locally even when the ACP provider times out or rejects its optional close request. A failed local write leaves the session unarchived.
- Open long conversations at the latest page. Earlier pages load on request and preserve the reading position; usage totals still reflect the full session.
- Keep archive-list and detail scrolling within the panel, remember list positions across filters, and wait for the MCP UI handshake before polling.
- Avoid rewriting intact history journals before the bridge can start serving requests.
- Stop the owned Windows ACP process tree on close. Release the shared bridge and its agents after the last MCP host disconnects, with a brief reconnect window.
- Share an ACP process per provider across Antigravity and Claude Code sessions, with independent permissions, cancellation, history, and archive. Claude's adapter continues to manage per-session CLI subprocesses.
- Load large tool output and original diagnostic events on demand in bounded pages. Report local archive persistence, ACP close and process cleanup separately.
- Virtualize the conversation timeline and keep the reading anchor when prepending older pages.
- Add opt-in Git worktrees for new sessions in the panel and root tool. Preserve the source checkout and retain worktree branches and files on archive.

## 1.1.0-beta.1 — 2026-11-06

First public Git marketplace beta, based on the locally verified 1.0.9 UI and ACP bridge.

- Portable `${PLUGIN_ROOT}` launcher, tagged Git marketplace source and MIT license.
- Per-user runtime/state/cache paths with custom drive support; no publisher home paths, account configuration or conversation data.
- Read-only environment report, optional AGY detection and actionable setup errors. Claude Code uses the installer's own standard configuration; CC Switch is optional.
- First-use dependency preparation with pinned public-registry lockfile, file checksums, installation lock and reusable runtime marker.
- Fresh-profile installation and synthetic permission/recovery/paged-history regressions, with Windows CI.
- Shared-session panel, model/effort selection, native permission UI, Markdown, compact tool groups, cache hit rate and archives.
- Incremental panel sync, hidden-page polling pause, routine recovery messages and prevention of thought expansion during historical paging.

Known limits: Windows only; shared working directory; no per-agent project selection; Agent login and model access are user-supplied; long-term renderer stability is still under beta observation.
