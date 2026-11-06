# Public beta architecture

- Root contains installation/release documentation and the Git marketplace catalog. plugin/ is the self-contained source loaded by the Codex plugin cache.
- Public MCP configuration uses Node and ${PLUGIN_ROOT}/bootstrap.mjs. No developer workstation path is registered.
- Bootstrap discovers a user-local home (or explicit custom location), verifies an allowlisted runtime manifest, installs pinned production dependencies from the public npm registry, and starts MCP from a versioned runtime directory. Diagnostic output never enters MCP stdout.
- Per-user state is independent of checkout/cache/runtime versions. An explicit installer may write a small user-local locator so custom-drive installations remain discoverable without system environment changes.
- Provider settings belong to the installer. AGY uses native executable discovery; Claude uses its adapter and standard authentication/configuration. The source contains no subscription credentials or author configuration.
- Default checks use synthetic transports. Clean-profile testing prepares dependencies in an isolated path and verifies protocol startup without Agent accounts or prompts. Real provider/model access and native desktop UI acceptance are separate evidence boundaries.

## Beta verification

- Synthetic protocol, permission, recovery, timeline, link and portability checks pass.
- Empty-user-profile bootstrap passes with no AGY executable, no publisher login/CC Switch settings and no model prompts. Custom paths containing spaces and Unicode, idempotent installation, authenticated bridge access and MCP tools/resources were checked.
- PowerShell environment checking/runtime preparation and isolated local marketplace installation pass. Real provider execution and native desktop rendering are separate acceptance steps.
