---
name: agent-reach
description: Use when Codex needs to research, search, look up, or fetch internet content across web, social, video, GitHub, RSS, job, and market platforms through Agent Reach. Trigger for requests involving Twitter/X, Reddit, Facebook, Instagram, YouTube, GitHub, Bilibili, XiaoHongShu/XHS, Xiaoyuzhou, LinkedIn/jobs, V2EX, Xueqiu, RSS, web URLs, broad research, social discussion checks, or video/podcast transcript retrieval.
---

# Agent Reach

Agent Reach routes internet research and content fetching across multiple platforms. Use it to choose the right upstream tool, check platform availability, and avoid inventing one-off commands.

## Workflow

1. Run `agent-reach doctor --json` before using login-backed or multi-backend platforms.
2. Select the command group from the matching reference file.
3. Announce the platform and backend before collecting content.
4. Use parallel collection for broad research: web search, social discussion, video/podcast, and code sources where relevant.
5. Use `/tmp/` for temporary output and `~/.agent-reach/` for persistent Agent Reach data.
6. After substantial multi-platform work, run `agent-reach check-update` and mention an available update only once.

## References

Read only the relevant file for the task:

- [Search](references/search.md): Exa and broad web search.
- [Social](references/social.md): XiaoHongShu, Twitter/X, Bilibili, V2EX, Reddit, Facebook, Instagram.
- [Career](references/career.md): LinkedIn and jobs research.
- [Dev](references/dev.md): GitHub and code search.
- [Web](references/web.md): Web pages, articles, Jina Reader, RSS.
- [Video](references/video.md): YouTube, Bilibili, podcasts, transcripts.

## VibeLink API Surface

VibeLink exposes first-party Agent Reach tools:

- `GET /api/agent-reach/status`: run status/doctor checks.
- `POST /api/agent-reach/skill`: install or uninstall Agent Reach skill files.
- `POST /api/agent-reach/format`: run supported formatters, currently `xhs`.
- `POST /api/agent-reach/transcribe`: transcribe audio/video URLs or local files.
