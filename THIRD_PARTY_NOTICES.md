# Third-party notices

Agent Dock is MIT licensed. Its lockfile pins external dependencies that are downloaded from the public npm registry during installation, rather than bundling provider credentials or local Agent installations.

- `@agentclientprotocol/claude-agent-acp`: Claude Code ACP adapter; see its installed package's LICENSE and README.
- `@anthropic-ai/claude-agent-sdk`: transitive Agent runtime dependency; its own license and service terms apply. Agent Dock's MIT license does not relicense this dependency or grant access to Claude services.
- `@modelcontextprotocol/ext-apps` and `@modelcontextprotocol/sdk`: MCP App and server libraries.
- `lucide`: UI icons, under its package license.
- `marked` and `dompurify`: Markdown parsing and HTML sanitization.
- `esbuild` and development-only `@resvg/resvg-js`: build tooling.

For exact versions, integrity hashes and license metadata, inspect `plugin/package-lock.json` and the LICENSE files within the installed runtime's `node_modules`. Antigravity/AGY is installed and authenticated separately and is not included in this repository or release archive. Brand names identify compatibility and do not imply affiliation or endorsement.
