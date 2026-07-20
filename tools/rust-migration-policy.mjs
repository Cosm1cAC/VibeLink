const DEFAULT_ROUTE_FIELDS = new Map([
  ["rust-http-frontdoor", "rust_http_canary"],
  ["status-http-route", "rust_status_http"],
  ["doctor-http-route", "rust_doctor_http"],
  ["devices-http-route", "rust_devices_http"],
  ["device-mutations-http-route", "rust_device_mutations_http"],
  ["pairing-http-route", "rust_pairing_http"],
  ["audit-http-route", "rust_audit_http"],
  ["settings-http-route", "rust_settings_http"],
  ["tool-events-http-route", "rust_tool_events_http"],
  ["tool-events-sse-http-route", "rust_tool_events_sse"],
  ["event-sync-http-route", "rust_event_sync_http"],
  ["workspace-http", "rust_workspace_http"]
]);

export function defaultOnPolicyErrors(manifest = {}, windowsMain = "") {
  const slices = new Map((manifest.slices || []).map((slice) => [slice.id, slice]));
  const errors = [];
  for (const [sliceId, field] of DEFAULT_ROUTE_FIELDS) {
    const slice = slices.get(sliceId);
    const enabledByDefault = windowsMain.includes(`effective.${field} = true;`);
    if (!slice) {
      errors.push(`${sliceId}: missing migration slice.`);
    } else if (enabledByDefault && slice.status !== "default-on") {
      errors.push(`${sliceId}: Rust default profile enables ${field}, but status is ${slice.status}.`);
    } else if (!enabledByDefault && slice.status === "default-on") {
      errors.push(`${sliceId}: status is default-on, but Rust default profile does not enable ${field}.`);
    }
  }
  return errors;
}

export function nodeRuntimeReadiness(manifest = {}) {
  const blockers = Array.isArray(manifest.nodeRuntime?.blockers) ? [...manifest.nodeRuntime.blockers] : [];
  if (manifest.nodeRuntime?.packaging !== "removable") {
    blockers.push({
      id: "native-release-entry",
      title: "Rust-only release entry and project-root discovery",
      status: "planned",
      nodeEntries: ["src/server.js"],
      rustTarget: "apps/windows/src/main.rs"
    });
  }
  return {
    ready: blockers.length === 0,
    blockerIds: blockers.map((blocker) => blocker.id),
    blockers
  };
}
