# Changelog

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
