# Android Capability Repair Checklist

- [ ] T1: Restore clean Android lint/test/build gate
- [ ] T2: Reconnect Live Call audio WebSocket
- [ ] T3: Integrate MobileResiliencePolicy with connectivity/lifecycle
- [ ] T4: Add long-running Live Call observability/smoke artifact
- [ ] T5: Stream and cancel attachment uploads
- [ ] T6: Authenticate attachment preview and external open
- [ ] T7: Persist message edit/delete/regenerate
- [ ] T8: Complete Firebase native push registration and bridge-push channel
- [ ] T9: Rotate/revoke current device push token
- [ ] T10: Add task change timeline and recovery
- [ ] T11: Complete Workspace context and create/upsert
- [ ] T12: Add PR review and complete worktree operations
- [ ] T13: Add command palette, full-text search, tags, and favorites
- [ ] T14: Close accessibility, localization, and rotation coverage

## Verification Gates

- [ ] After T1-T4: Live Call survives disconnect/reconnect without duplicate jobs.
- [ ] After T5-T7: Attachments and message mutations are authenticated, bounded, and persistent.
- [ ] After T8-T9: Push registration, delivery, rotation, and revocation pass on a device.
- [ ] After T10-T12: Task and Workspace workflows survive refresh, reconnect, and destructive-action confirmation.
- [ ] Final: matrix updated, all focused tests/builds/lint/instrumentation/bridge smoke pass.
