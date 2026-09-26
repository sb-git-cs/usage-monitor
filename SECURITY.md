# Security policy

Usage Monitor reads CLI login tokens and, on Windows, runs a capture helper as SYSTEM, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through [GitHub security advisories](https://github.com/sb-git-cs/usage-monitor/security/advisories/new). Include the version or commit, your OS, and steps to reproduce.

You should get a reply within a few days. Fixes ship in a new release, and the advisory is published once users can update.

## Supported versions

Only the latest release and `main` receive security fixes.

## Scope

In scope: token handling, the Windows network helper and its named pipe, firewall rule management, the updater, and rendering of provider data in the UI. Vulnerabilities in the CLIs themselves (Claude Code, Codex, Gemini, Grok) should go to their vendors.
