# Agent Dock contributor instructions

- Windows beta. Node >=22. Runtime source is in plugin/. The Git marketplace at .agents/plugins/marketplace.json points to ./plugin.
- Build: npm ci --prefix plugin --ignore-scripts; npm run build --prefix plugin; node scripts/release.mjs. Commit panel.html and runtime-files.json together. CI verifies generated output matches source.
- Tests: npm test --prefix plugin. Clean setup: node plugin/verify-clean-install.mjs. No paid Agent prompts in default tests.
- After changing plugin manifests, also install from an isolated marketplace and verify `open_panel` and its UI resource with the desktop app-server. An MCP SDK test alone does not exercise Codex's manifest handling.
- Keep source/runtime paths portable. Never commit credentials, user settings, installed dependencies, state, transcripts, logs or local test evidence. .qa/ and plugin/work/ are ignored.
- bootstrap.mjs owns per-user dependency setup; environment.mjs resolves paths and reports capabilities without reading credentials. paths.mjs keeps shared state outside versioned/cache directories. Existing services are reused without replaying tasks.
- service.mjs owns ACP children and permission queues. Never silently auto-approve; preserve full offered tool details. Root tool callers cannot supply executable paths. User-local AGY configuration is allowed.
- Preserve internal MCP name agy_acp_probe and resource URI ui://agy-acp-probe/panel-v2.html for compatibility. Product and public marketplace names are Agent Dock / agent-dock.
- Model and thought level must be confirmed by the provider. No invented model catalogs or thought text. Unknown token fields remain unknown.
- Only newly observed normal recovery events produce one dismissible message. Preserve critical recovery notices and raw diagnostic events. Incomplete historical pages cannot produce open streaming thoughts.
- Use four-space indentation and named business functions. Update .Codex/memory/ for nontrivial architecture or release changes with public-safe implementation notes only.
- Do not publish or upload without user authorization. Validate staged files before a release. Git commits use a summary, a blank line, file bullets and a Co-Authored-By line.
