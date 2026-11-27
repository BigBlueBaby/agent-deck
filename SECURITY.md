# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `2.x`   | Yes       |

## Security Architecture Highlights

- **Local-Only Secrets**: Custom provider API keys are stored only in `${PLUGIN_DATA}/config.json` on your machine, masked before returning to the UI, and never exposed to LLM prompts or tool outputs.
- **Strict Path Allowlist**: Write tasks enforce workspace-relative `allowedPaths` and reject symlink escapes.
- **Zero External UI Resources**: The bundled MCP App UI (`dist/workbench.html`) contains zero external `<script>` or `<link>` dependencies.

## Reporting a Vulnerability

If you discover a security vulnerability (such as secret leakage, path traversal, or command injection), please **do not** open a public issue with exploit details.

Instead, report it privately via [GitHub Security Advisories](https://github.com/BigBlueBaby/agent-deck/security/advisories/new) so we can verify and release a patch promptly.
