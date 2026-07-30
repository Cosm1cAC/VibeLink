# Release Candidate Evidence

Every release candidate must have one sanitized manifest that ties runtime evidence to a Git commit and binary SHA-256. The gate requires:

1. At least one real Provider task.
2. A natural MCP run, or an explicit release-owner waiver when the optional runtime or index is unavailable.
3. A terminal recovery run.
4. A weak-network Live Call run with at least one reconnect.
5. A completed physical Android device checklist.

Each completed evidence entry records the external implementation name/version, request count, fallback count, failure count, p95 latency, and cleanup result. Do not include prompts, responses, account identifiers, device serials, tokens, credentials, absolute local paths, or raw logs. The validator rejects common secret fields and token-shaped values.

Validate a release candidate:

```powershell
npm run release:candidate-evidence -- --manifest .tmp/release-evidence/release-candidate/manifest.json
```

Pass `--expected-commit <full-commit>` when validating outside CI. The workflow always supplies its checked-out commit and rejects a stale manifest.

Use `--allow-incomplete` only to validate and archive a manifest while prerequisites are unavailable. It never reports the manifest as release-candidate evidence:

```powershell
npm run release:candidate-evidence -- --manifest .tmp/release-evidence/release-candidate/manifest.json --allow-incomplete
```

Completed entries use this shape:

```json
{
  "status": "passed",
  "implementation": { "name": "provider-or-runtime", "version": "1.2.3" },
  "metrics": { "requestCount": 10, "fallbackCount": 0, "failureCount": 0, "p95Ms": 125 },
  "cleanup": { "status": "passed" }
}
```

An unavailable prerequisite is recorded without installing an untrusted global tool:

```json
{
  "status": "not-run",
  "reason": "prerequisite unavailable",
  "prerequisite": "optional MCP runtime or indexed project is unavailable",
  "cleanup": { "status": "not-run" }
}
```

For the natural MCP release-candidate exception, add an explicit waiver:

```json
{
  "status": "not-run",
  "reason": "prerequisite unavailable",
  "prerequisite": "codebase-memory-mcp is not installed or the project is not indexed",
  "waiver": { "approvedBy": "release-owner", "reason": "Optional local integration is unavailable." },
  "cleanup": { "status": "not-run" }
}
```

Completed category-specific fields are `provider.taskCount` and `durationSeconds`, `mcp.naturalRun`, `terminal.recoveryCount` and `durationSeconds`, `liveCall.weakNetwork`, `reconnectCount`, and `durationSeconds`, plus all Android checklist booleans enforced by the validator.

The Provider, terminal, Live Call, and Android entries cannot be waived by the release-candidate gate. The Android checklist summary does not replace the phone/tablet artifact validator in [android-device-evidence.md](./android-device-evidence.md); production release runs should enable both workflow gates.
