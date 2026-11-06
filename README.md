# Agent Dock

Manage Antigravity and Claude Code as local ACP subagents from Codex desktop, with a shared conversation panel.

**Windows beta · `1.1.0-beta.1` · MIT**

Agent Dock provides root tools to create, configure, prompt, inspect, cancel and close agents. Its panel displays conversations, received thought text, grouped tool calls, permission requests, usage and archives. Chats using the same installation share the same agents. Sessions survive bridge restarts when their provider supports recovery; interrupted tasks and approvals are never automatically replayed.

This is a community Git marketplace plugin, not an official OpenAI directory listing. It does not include an Agent subscription, API credits, provider credentials or conversations.

## Requirements

- Windows 10/11, Node.js **22 or newer**, including npm.
- A Codex desktop version that supports local plugins and MCP Apps. Install Codex CLI and Git for the commands below.
- Network access to GitHub and `registry.npmjs.org` for first installation.
- At least one configured Agent when you want to send tasks:
    - **Antigravity**: install its native `agy.exe`, verify `agy acp` is available, and sign in through that CLI. Agent Dock checks `AGY_BIN`, `PATH`, `%LOCALAPPDATA%\agy\bin\agy.exe`, then `%USERPROFILE%\.agy\bin\agy.exe`.
    - **Claude Code**: authenticate with your own Claude Code login or standard provider configuration. The pinned `@agentclientprotocol/claude-agent-acp` adapter is installed automatically. CC Switch is optional; Agent Dock neither installs it nor copies anyone's configuration.

The panel can start without either Agent being logged in. Environment checks do not prove authentication or model access; those are confirmed by the Agent when creating a session. AGY and Claude Code are independent, so missing AGY does not prevent Claude Code use.

## Install from the Git marketplace

In PowerShell:

```powershell
codex plugin marketplace add https://github.com/LingYzh/agent-dock.git --ref v1.1.0-beta.1
codex plugin add agent-dock@agent-dock
```

Refresh the desktop's plugin connection (or restart the desktop). On first use, Agent Dock verifies its bundled runtime files and installs pinned npm dependencies into your user data directory. This can take a few minutes on a slow connection; later launches reuse the prepared runtime. If startup times out, run the installer below to prepare dependencies before reopening the panel.

In the current chat, open the right content panel's **+ → More tools → Agent Dock**. Clicking the plugin's management card opens plugin details instead of the agent panel. You can also mention Agent Dock in the chat and ask it to open the panel or create an agent.

## Check the environment / choose another drive

Download and extract the [GitHub prerelease](https://github.com/LingYzh/agent-dock/releases/tag/v1.1.0-beta.1), or clone this repository at that tag. Run inside the extracted/cloned directory:

```powershell
# Read-only environment report; no Agent prompts or authentication checks.
./install.ps1 -CheckOnly

# Prepare dependencies and register the tagged Git source.
./install.ps1

# Optional: choose a drive and an AGY executable installed elsewhere.
./install.ps1 -HomeDirectory 'D:\Tools\AgentDock' -AgyBin 'D:\Apps\agy\agy.exe'

# Prepare runtime only, without changing Codex plugin registration.
./install.ps1 -SkipPluginRegistration
```

If PowerShell refuses downloaded scripts, inspect the downloaded files and run `Unblock-File -LiteralPath ./install.ps1` for this file only. The installer never changes machine execution policy and does not need administrator access.

Default home: `%LOCALAPPDATA%\AgentDock`. No `C:\Users\...` account name or fixed data drive is embedded in the plugin. `-HomeDirectory` keeps runtime, npm cache and default state together on a chosen drive. A tiny `%LOCALAPPDATA%\AgentDock\installation.json` path pointer allows the desktop to find that location; it contains no credentials. `-StateDirectory` can place sessions separately.

Advanced precedence:

| Setting | Resolution, highest priority first |
| --- | --- |
| Home | Installer `-HomeDirectory` → `AGENT_DOCK_HOME` → user path pointer → default user-local directory |
| State | Installer `-StateDirectory` → `AGENT_DOCK_STATE_DIR` → home's `settings.json` → `<home>\state` |
| AGY | Installer `-AgyBin` → `AGY_BIN` → home's `settings.json` → executable discovery |

Environment variables must be visible to the desktop process; restart the desktop after changing them. No credentials belong in these settings files. Standard `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CONFIG_DIR` are passed to Claude when present; their values are never printed by the environment check.

## Use

- Press **+** in the panel. Choose Agent, then its actual model and reasoning/effort options. Changing Agent closes the unused preparation; cancelling the dialog closes the current preparation. Neither action sends a task.
- Root can use `agent_spawn` with `provider`, `model` and `thoughtLevel`, then `agent_send` / `agent_get` / `agent_wait`. Unsupported model or effort values fail explicitly.
- Omitted AGY model defaults to `gemini-3.8-flash`; this requires that model to be available to your account. Choose another actual catalog entry when needed. Claude's default comes from its own configuration.
- The bridge surfaces ACP permission requests with the exact offered choices. It does not override the Agent's existing permission policy; an Agent configured to auto-allow may not ask.
- All agents currently work in `<state>\work\fixture`, a shared working directory. This is not the current root chat's project and is not a sandbox. Per-agent project/worktree selection is not included in this beta.
- Current and archived lists are separate. Closed sessions remain readable. Ordinary recovery notifications disappear after four seconds; significant interrupted/recreated notices remain in history. Diagnostics retain original events.
- Usage comes from the Agent, not a subscription-billing API. Unknown fields stay unknown. Cache hit rate excludes output. Thought text is displayed only when the Agent actually sends it.

## Upgrade, migration and uninstall

This installation is pinned to the beta tag. To opt into a later release, use its published tag with `codex plugin marketplace add … --ref <new-tag>`, then refresh the marketplace/plugin in the desktop. A `main` source can track repository changes with `codex plugin marketplace upgrade agent-dock`; use tagged releases for reproducibility. New runtime versions use separate folders; state stays outside them.

If you previously installed a development package named `agent-dock@agent-dock-local`, disable that old plugin before enabling this public source, to avoid duplicate tool registrations. To retain its existing sessions, pass its existing state directory explicitly via `-StateDirectory`. Do not run two bridge services against the same state directory. Finish or cancel active work before switching installations. The installer does not automatically stop services or modify the old package.

Remove the public plugin with:

```powershell
codex plugin remove agent-dock@agent-dock
codex plugin marketplace remove agent-dock
```

Uninstalling the plugin does not delete runtime or conversations. Stop using the plugin and close the desktop before manually removing its data directory. Keep the `state` folder if you want to preserve conversations. Do not delete someone else's shared state.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `node` is not found | Install Node.js 22+ with npm and restart the desktop so its PATH updates. |
| npm is missing | Use a Node distribution that includes npm; run `install.ps1 -CheckOnly`. |
| First startup fails or times out | Run `install.ps1 -SkipPluginRegistration`; check network/proxy access to the public npm registry. Failed preparations do not get a ready marker and can be retried. |
| Antigravity CLI not found | Set `AGY_BIN` to an existing native `agy.exe`, or rerun installer with `-AgyBin`; Claude remains independently available. |
| Agent authentication / provider error | Authenticate that Agent separately or fix your own provider configuration. No publisher account is bundled. |
| Model / effort rejected | Use the new-session dialog's catalog. Existing sessions can have older catalogs. |
| Panel shows an old UI | Refresh the plugin connection and open a fresh Agent Dock panel; a loaded HTML document may be cached by the host. |
| A local file link does not open | The host controls local-file links. The panel retains the destination for copying when needed. |
| Recovery fails | History remains readable with an error; the bridge will not automatically replay a task or replace a history-bearing session. |

## Development and validation

```powershell
npm ci --prefix plugin --ignore-scripts --registry=https://registry.npmjs.org
npm test --prefix plugin
npm run build --prefix plugin
node scripts/release.mjs
node plugin/verify-clean-install.mjs
```

Commit the built `plugin/panel.html` and `plugin/runtime-files.json` together with source changes. The first-use launcher needs these generated files; it does not compile frontend source on the user's computer. Runtime installation ignores npm lifecycle scripts. Node and pinned dependencies are required; this is not an offline standalone executable.

Tests use synthetic ACP peers and an empty profile. They do not send paid model prompts. A successful clean install verifies the launcher, registry, MCP tools/resource, error messages and isolated paths; it does not prove that every user's Agent login, subscription model catalog or desktop version will work. Only Windows is supported and tested in this beta.

## License

MIT, © 2026 LingYzh. Dependencies retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
