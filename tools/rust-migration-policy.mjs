import fs from "node:fs";
import path from "node:path";

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

function readJson(relativePath) {
  const fullPath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function walkFiles(dir, extension, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "target") walkFiles(fullPath, extension, output);
    } else if (entry.name.endsWith(extension)) {
      output.push(fullPath);
    }
  }
  return output;
}

function normalizeMethod(method) {
  return String(method || "").trim().toUpperCase();
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\/+$/, "") || "/";
}

function pathMatches(pattern, candidate) {
  const normalizedPattern = normalizePath(pattern);
  const normalizedCandidate = normalizePath(candidate);
  if (normalizedPattern.endsWith("/*")) {
    return normalizedCandidate === normalizedPattern.slice(0, -2) || normalizedCandidate.startsWith(`${normalizedPattern.slice(0, -1)}/`);
  }
  return normalizedCandidate === normalizedPattern;
}

function operationKey(method, route) {
  return `${normalizeMethod(method)} ${normalizePath(route)}`;
}

function sortedRoutes(routes) {
  return [...new Set(routes)].sort();
}

function collectNodeRuntimeRoutes(source) {
  const routes = [];
  const pathFirst = /url\.pathname\s*(?:===|==)\s*["`]([^"`]+)["`]\s*&&\s*request\.method\s*(?:===|==)\s*["`]([A-Z]+)["`]/g;
  const methodFirst = /request\.method\s*(?:===|==)\s*["`]([A-Z]+)["`]\s*&&\s*url\.pathname\s*(?:===|==)\s*["`]([^"`]+)["`]/g;
  for (const match of source.matchAll(pathFirst)) {
    routes.push(operationKey(match[2], match[1]));
  }
  for (const match of source.matchAll(methodFirst)) {
    routes.push(operationKey(match[1], match[2]));
  }
  return sortedRoutes(routes);
}

function collectRustRuntimeRoutes(root) {
  const routes = [];
  for (const file of walkFiles(path.resolve(root, "apps/windows/src"), ".rs")) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"\s*\)/g)) {
      routes.push(operationKey(match[1], match[2]));
    }
    for (const match of source.matchAll(/request\.method\s*(?:!=|==)\s*"([A-Z]+)"[\s\S]{0,120}?request\.path\(\)\s*(?:!=|==)\s*"([^"]+)"/g)) {
      routes.push(operationKey(match[1], match[2]));
    }
  }
  return sortedRoutes(routes);
}

function collectRuntimeRoutes(root = process.cwd()) {
  const nodeSource = fs.readFileSync(path.resolve(root, "src/server.js"), "utf8");
  return sortedRoutes([
    ...collectNodeRuntimeRoutes(nodeSource),
    ...collectRustRuntimeRoutes(root)
  ]);
}

function collectOpenApiOperations(openapi) {
  const operations = [];
  for (const [route, methods] of Object.entries(openapi?.paths || {})) {
    for (const [method, spec] of Object.entries(methods || {})) {
      operations.push({
        key: operationKey(method, route),
        method: normalizeMethod(method),
        path: normalizePath(route),
        operationId: spec?.operationId || ""
      });
    }
  }
  return operations;
}

function collectOwnershipEntries(manifest) {
  if (Array.isArray(manifest?.families)) return manifest.families;
  if (!Array.isArray(manifest?.publicRouteFamilies)) return [];
  return manifest.publicRouteFamilies.map((family) => ({
    ...family,
    openapi: [
      ...(family.prefixes || []).map((pathPrefix) => ({ pathPrefix, methods: ["*"] })),
      ...(family.routes || []).map((route) => {
        const [method, ...pathParts] = String(route).split(" ");
        return { path: pathParts.join(" "), methods: [method] };
      })
    ],
    nodeEntries: family.nodeEntries || [family.id],
    rustTarget: family.rustTarget || "docs/route-ownership.json"
  }));
}

function entryMatchesOperation(entry, operation) {
  const methods = Array.isArray(entry?.methods) && entry.methods.length ? entry.methods.map(normalizeMethod) : ["*"];
  const pathMatch = entry.pathPrefix
    ? normalizePath(operation.path).startsWith(normalizePath(entry.pathPrefix))
    : pathMatches(entry.path, operation.path);
  const methodMatch = methods.includes("*") || methods.includes(operation.method);
  return pathMatch && methodMatch;
}

function familyMatchesOperation(family, operation) {
  const entries = Array.isArray(family?.openapi) ? family.openapi : [];
  return entries.some((entry) => entryMatchesOperation(entry, operation));
}

export function ownershipReadiness(manifest = {}, openapi = null) {
  const families = collectOwnershipEntries(manifest);
  const operations = openapi ? collectOpenApiOperations(openapi) : [];
  const blockers = [];
  const operationOwners = new Map();
  const runtimeEntries = new Set();
  const familyIds = new Set();
  const duplicateFamilyIds = [];

  for (const family of families) {
    const familyId = family?.id || "unknown";
    const owner = String(family?.owner || "").trim().toLowerCase();
    if (!family?.id) {
      blockers.push({
        id: "ownership-family-missing-id",
        title: "Ownership manifest family missing id",
        status: "planned",
        nodeEntries: [],
        rustTarget: ""
      });
      continue;
    }
    if (familyIds.has(familyId)) duplicateFamilyIds.push(familyId);
    familyIds.add(familyId);
    if (!owner) {
      blockers.push({
        id: `ownership-${familyId}-missing-owner`,
        title: `Ownership family ${familyId} is missing an owner`,
        status: "planned",
        nodeEntries: [],
        rustTarget: ""
      });
    }
    for (const entry of family.openapi || []) {
      const methods = Array.isArray(entry.methods) && entry.methods.length ? entry.methods : ["*"];
      for (const method of methods) {
        const key = operationKey(method, entry.pathPrefix || entry.path);
        if (key.includes("undefined")) continue;
        runtimeEntries.add(`${familyId}:${key}`);
      }
    }
    for (const operation of operations) {
      if (familyMatchesOperation(family, operation)) {
        const owners = operationOwners.get(operation.key) || [];
        owners.push(familyId);
        operationOwners.set(operation.key, owners);
      }
    }
    if ((family.requiredForRustOnly !== false) && owner !== "rust") {
      blockers.push({
        id: `ownership-${familyId}-not-rust-owned`,
        title: `Rust-only package still depends on ${familyId} owned by ${owner || "unknown"}`,
        status: owner || "planned",
        nodeEntries: Array.isArray(family.nodeEntries) ? family.nodeEntries : [],
        rustTarget: family.rustTarget || family.runtime?.[0]?.path || ""
      });
    }
    if (family.rustFlag && manifest?.windowsMain && !String(manifest.windowsMain).includes(`effective.${family.rustFlag} = true;`)) {
      blockers.push({
        id: `ownership-${familyId}-missing-rust-flag`,
        title: `Rust family ${familyId} is missing default-profile wiring`,
        status: "planned",
        nodeEntries: [],
        rustTarget: family.rustTarget || ""
      });
    }
  }

  if (duplicateFamilyIds.length) {
    blockers.push({
      id: "ownership-family-duplicate-id",
      title: "Ownership manifest contains duplicate family ids",
      status: "planned",
      nodeEntries: duplicateFamilyIds,
      rustTarget: "docs/route-ownership.json"
    });
  }

  const missingOpenApi = operations.filter((operation) => !operationOwners.has(operation.key));
  if (missingOpenApi.length) {
    blockers.push({
      id: "ownership-openapi-unowned",
      title: "OpenAPI operations are missing ownership coverage",
      status: "planned",
      nodeEntries: missingOpenApi.map((operation) => operation.key),
      rustTarget: "docs/route-ownership.json"
    });
  }
  const duplicateOpenApi = Array.from(operationOwners.entries()).filter(([, owners]) => owners.length > 1);
  if (duplicateOpenApi.length) {
    blockers.push({
      id: "ownership-openapi-ambiguous",
      title: "OpenAPI operations match more than one ownership family",
      status: "planned",
      nodeEntries: duplicateOpenApi.map(([operation, owners]) => `${operation} => ${owners.join(",")}`),
      rustTarget: "docs/route-ownership.json"
    });
  }

  const orphanedOwnership = families.filter((family) =>
    Array.isArray(family.openapi) && family.openapi.some((entry) => {
      return !operations.some((operation) => entryMatchesOperation(entry, operation));
    })
  );
  if (orphanedOwnership.length) {
    blockers.push({
      id: "ownership-manifest-stale",
      title: "Ownership manifest references routes not present in OpenAPI",
      status: "planned",
      nodeEntries: orphanedOwnership.map((family) => family.id),
      rustTarget: "docs/openapi.json"
    });
  }

  const runtimeRoutes = Array.isArray(manifest?.runtimeRoutes) ? manifest.runtimeRoutes : [];
  if (runtimeRoutes.length) {
    const unownedRuntime = runtimeRoutes.filter((route) => {
      const [, routePath = ""] = String(route).split(" ");
      return routePath.startsWith("/api/") && !families.some((family) =>
        familyMatchesOperation(family, {
          key: route,
          method: String(route).split(" ")[0],
          path: routePath
        })
      );
    });
    const runtimeApiRoutes = runtimeRoutes.filter((route) => String(route).includes(" /api/"));
    const openapiKeys = new Set(operations.map((operation) => operation.key));
    const runtimeKeys = new Set(runtimeApiRoutes);
    const openapiOnly = operations.filter((operation) => !runtimeKeys.has(operation.key));
    const runtimeOnly = runtimeApiRoutes.filter((route) => !openapiKeys.has(route));
    if (unownedRuntime.length || openapiOnly.length || runtimeOnly.length) {
      blockers.push({
        id: "ownership-runtime-registry-diff",
        title: "OpenAPI, runtime route registry, and ownership manifest differ",
        status: "planned",
        nodeEntries: [
          ...unownedRuntime.map((route) => `unowned runtime: ${route}`),
          ...openapiOnly.map((operation) => `openapi only: ${operation.key}`),
          ...runtimeOnly.map((route) => `runtime only: ${route}`)
        ],
        rustTarget: "docs/route-ownership.json"
      });
    }
  }

  const internalFamilies = Array.isArray(manifest?.internalRouteFamilies) ? manifest.internalRouteFamilies : [];
  if (internalFamilies.length) {
    blockers.push({
      id: "ownership-internal-node-routes",
      title: "Hybrid-only internal Node routes are still required",
      status: "planned",
      nodeEntries: internalFamilies.flatMap((family) => family.routes || [family.id]),
      rustTarget: "docs/route-ownership.json"
    });
  }

  const nonRustResponsibilities = (manifest?.responsibilities || []).filter((responsibility) => {
    const owner = String(responsibility?.owner || "").toLowerCase();
    const status = String(responsibility?.status || "").toLowerCase();
    return owner !== "rust" || !["default-on", "required-for-rust-only"].includes(status);
  });
  if (nonRustResponsibilities.length) {
    blockers.push({
      id: "ownership-product-responsibilities-not-rust",
      title: "Non-HTTP product responsibilities are not fully Rust-owned",
      status: "planned",
      nodeEntries: nonRustResponsibilities.map((responsibility) => responsibility.id || "unknown"),
      rustTarget: "docs/route-ownership.json"
    });
  }

  const acceptance = manifest?.rustOnlyAcceptance || manifest?.rustOnlyCanary || {};
  const forbiddenNode = acceptance.forbiddenPackageEntries || [];
  const requiredFamilies = acceptance.requiredFamilies || acceptance.requiredHttpFamilies || [];
  const requiredStreamingFamilies = acceptance.requiredStreamingFamilies || [];
  const missingAcceptance = [];
  for (const field of ["forbiddenPackageEntries", "forbiddenProcessNames", "packageSmoke"]) {
    const value = acceptance[field];
    if (Array.isArray(value) ? value.length === 0 : !value) missingAcceptance.push(field);
  }
  const missingRequiredFamilies = requiredFamilies.filter((id) => !familyIds.has(id));
  if (missingAcceptance.length || missingRequiredFamilies.length) {
    blockers.push({
      id: "ownership-rust-only-acceptance-incomplete",
      title: "Rust-only package acceptance checks are incomplete",
      status: "planned",
      nodeEntries: missingAcceptance,
      rustTarget: "docs/route-ownership.json"
    });
  }

  return {
    ready: blockers.length === 0,
    blockerIds: blockers.map((blocker) => blocker.id),
    blockers,
    ownedOperationKeys: Array.from(operationOwners.keys()),
    runtimeEntries: Array.from(runtimeEntries),
    forbiddenNode,
    requiredFamilies,
    requiredStreamingFamilies
  };
}

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
  let ownership = { blockers: [] };
  try {
    const openapi = readJson("docs/openapi.json");
    const routeOwnership = readJson("docs/route-ownership.json");
    ownership = ownershipReadiness(
      {
        ...routeOwnership,
        windowsMain: fs.readFileSync(path.resolve(process.cwd(), "apps/windows/src/main.rs"), "utf8"),
        runtimeRoutes: collectRuntimeRoutes()
      },
      openapi
    );
  } catch (error) {
    blockers.push({
      id: "ownership-manifest-unreadable",
      title: `Ownership manifest is unreadable: ${error.message}`,
      status: "planned",
      nodeEntries: ["docs/openapi.json", "docs/route-ownership.json"],
      rustTarget: "tools/rust-migration-policy.mjs"
    });
  }
  for (const blocker of ownership.blockers || []) {
    blockers.push(blocker);
  }
  return {
    ready: blockers.length === 0,
    blockerIds: blockers.map((blocker) => blocker.id),
    blockers,
    ownership
  };
}
