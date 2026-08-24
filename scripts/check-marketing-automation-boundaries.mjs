import { readFile } from "node:fs/promises";

const files = {
  syncManifest: "packages/plugins/sa-github-content-sync/emdash-plugin.jsonc",
  insightsManifest: "packages/plugins/sa-content-insights/emdash-plugin.jsonc",
  analyticsRuntime: "packages/plugins/sa-analytics-collector/src/index.ts",
  architecture: "docs/marketing-automation/architecture.md",
  reuseAudit: "docs/marketing-automation/reuse-audit.md",
};

const contents = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")]),
  ),
);

const violations = [];
const requireMatch = (key, pattern, message) => {
  if (!pattern.test(contents[key])) violations.push(message);
};
const forbidMatch = (key, pattern, message) => {
  if (pattern.test(contents[key])) violations.push(message);
};

requireMatch("syncManifest", /"content:write"/, "GitHub sync must declare content:write");
requireMatch("syncManifest", /"media:write"/, "GitHub sync must declare media:write");
requireMatch("syncManifest", /"network:request"/, "GitHub sync must use an allowlisted network capability");
forbidMatch(
  "syncManifest",
  /network:request:unrestricted/,
  "GitHub sync must not request unrestricted network access",
);

forbidMatch(
  "insightsManifest",
  /"content:write"|"media:write"|network:request:unrestricted/,
  "Content insights must remain a read-only editorial projection",
);

forbidMatch(
  "analyticsRuntime",
  /content:write|media:write/,
  "Analytics collector must not mutate editorial content or media",
);
requireMatch(
  "analyticsRuntime",
  /format:\s*"native"/,
  "Analytics collector must remain native while it owns browser script integration",
);

requireMatch(
  "architecture",
  /Production content must not|does not.*autonomous|may not merge or publish/is,
  "Architecture must preserve the human release gate",
);
requireMatch(
  "reuseAudit",
  /CloudFlare-CMS/,
  "Reuse audit must retain the CloudFlare-CMS source map",
);
requireMatch("reuseAudit", /Growth-OS/, "Reuse audit must retain the Growth-OS source map");

if (violations.length > 0) {
  console.error("Marketing automation boundary check failed:\n");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Marketing automation boundaries are intact.");
}
