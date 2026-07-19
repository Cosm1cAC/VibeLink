# VibeLink — Agent Onboarding Guide

This file is for AI coding agents that interact with VibeLink's HTTP API.  
It describes the protocol conventions, key endpoints, and interaction patterns.

---

## Protocol

- **Base URL**: `http://<bridge-ip>:<port>` (default port: `5177`)
- **Content-Type**: All requests and responses use `application/json`
- **Authorization**: `Authorization: Bearer <token>` header, or `?token=<token>` query parameter
- JSON is the default response format. The authenticated artifact range endpoint returns bounded `application/octet-stream` partial content.

## Discovery Endpoints

| Purpose | Method | Path |
|---------|--------|------|
| List all tools with schemas | `GET` | `/api/tool-registry?fields=name,inputSchema,outputSchema` |
| List Agent providers, models, health, and execution fidelity | `GET` | `/api/provider-registry` |
| Get runtime configuration | `GET` | `/api/status` |
| Full system diagnosis | `GET` | `/api/doctor` |
| List built-in commands | `GET` | `/api/command-registry?fields=name,params` |
| List MCP server status | `GET` | `/api/mcp/status` |

## List Endpoints (all support pagination and field selection)

| Resource | Method | Path | Pagination |
|:---------|:-------|:-----|:-----------|
| Tasks | `GET` | `/api/tasks?after=&limit=&fields=` | cursor, default 100 |
| Histories | `GET` | `/api/histories?fields=` | none |
| Workspaces | `GET` | `/api/workspaces?fields=` | none |
| Tool runs | `GET` | `/api/tool-runs?after=&limit=&fields=` | cursor, default 100 |
| Tool events | `GET` | `/api/tool-events?after=&limit=&fields=` | cursor, default 1000 |
| Tool events (stream) | `GET` | `/api/tool-events?stream=1&after=` | SSE stream |
| Approvals | `GET` | `/api/approvals?status=&workspaceId=&limit=&fields=` | limit, default 100 |
| Devices | `GET` | `/api/devices?fields=` | none |
| Pairing sessions | `GET` | `/api/pairing-sessions?status=&fields=` | none |
| Audit log | `GET` | `/api/audit-log?after=&limit=&fields=` | cursor, default 200 |
| Unified events | `GET` | `/api/events/unified?after=&limit=&fields=` | cursor, default 200 |
| Event acknowledgements | `GET` | `/api/events/acks?streamId=` | none |
| Event retention plan | `GET` | `/api/events/retention-plan?streamId=&retentionDays=&keepLatest=` | none |
| Event compaction markers | `GET` | `/api/events/compaction-markers?streamId=&after=&limit=` | cursor, default 100 |
| Live calls | `GET` | `/api/live-calls?fields=` | none |
| Terminal sessions | `GET` | `/api/terminal-sessions?fields=` | none |
| Desktop observations | `GET` | `/api/desktop-remote/observations?after=&limit=&fields=` | cursor, default 100 |

### Pagination Rules

- `after` is a cursor (integer ID, timestamp, or event sequence number). Pass the last `id` or `cursor` from the previous response.
- `limit` controls maximum items per response (range: 1–5000, varies by endpoint).
- `fields` accepts a comma-separated list of property names. Use dot notation for nested fields: `?fields=id,title,events.type`.

## Mutation Endpoints

| Purpose | Method | Path | Dry run |
|:--------|:-------|:-----|:--------|
| Execute workspace command | `POST` | `/api/workspaces/:id/command?dryRun=1` | ✅ |
| Create task | `POST` | `/api/tasks?dryRun=1` | ✅ |
| Update settings | `POST` | `/api/settings?dryRun=1` | ✅ |
| Browser fetch | `POST` | `/api/browser/fetch?dryRun=1` | ✅ |
| Git action | `POST` | `/api/workspaces/:id/git/action?dryRun=1` | ✅ |
| Create workspace | `POST` | `/api/workspaces?dryRun=1` | ✅ |
| Prune tool events | `POST` | `/api/tool-events/prune` (body `dryRun: true`) | ✅ |
| Acknowledge event stream | `POST` | `/api/events/ack` | n/a |
| Compact event stream | `POST` | `/api/events/compact` (body `dryRun: true`) | ✅ |

When `?dryRun=1` is set, the endpoint runs validation and risk assessment but performs no side effects.  
Response format: `{ dryRun: true, wouldValidate: {...}, approvalRequired: bool }`.

## Approval Flow

High-risk operations return **HTTP 428 Precondition Required** with body:
```json
{
  "error": "...requires explicit approval",
  "approval": { "id": "...", "kind": "workspace.command" },
  "approvalId": "...",
  "reasons": ["recursive_delete"],
  "matches": ["rm -rf"],
  "policy": { "sandboxMode": "workspace-write" }
}
```

To approve, POST to `/api/approvals/:approvalId/decision`:
```json
{ "decision": "approve", "reason": "Approved after review." }
```

To deny:
```json
{ "decision": "deny", "reason": "Unsafe operation." }
```

## Rate Limiting

All mutation endpoints are rate-limited. Response headers:
- `X-RateLimit-Limit` — max requests in the window
- `X-RateLimit-Remaining` — remaining requests
- `X-RateLimit-Reset` — timestamp (ms) when the window resets
- `Retry-After` — seconds to wait (only on 429 responses)

## Error Format

All errors follow the same structure:
```json
{ "error": "Human-readable error message." }
```

HTTP status codes: `400` (validation), `401` (auth), `403` (forbidden), `404` (not found),  
`409` (conflict), `413` (too large), `428` (approval needed), `429` (rate limit), `500` (server error).

## Design System

For visual identity tokens (colors, typography, spacing, components), see `DESIGN.md` in the project root.

## Git Workflow

- After completing any repository update, stage the changed files, commit them, and push the current branch to `origin` unless the user explicitly asks not to.
- Before committing, run the focused tests or build commands that match the edited surface and include the verification result in the handoff.

## Skills

VibeLink ships structured skill files in `.agents/skills/` that encode agent workflows:
- `tdd/SKILL.md` — Red-Green-Refactor TDD workflow
- `ink/SKILL.md` — Terminal UI rendering with JSON specs
- `agent-dx-cli-scale/SKILL.md` — CLI agent-readiness evaluation
- `typed-service-contracts/SKILL.md` — Spec & Handler architecture pattern
- `agent-reach/SKILL.md` — Multi-platform research and content fetching
