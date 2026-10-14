import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";

const CARGO_ARGS = [
  "build",
  "--release",
  "--locked",
  "--jobs",
  "2",
  "--manifest-path",
  path.join("rust", "gateway", "Cargo.toml"),
];

export function buildGateway() {
  const result = spawnSync("cargo", CARGO_ARGS, {
    cwd: SOURCE_ROOT,
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") {
    console.error("cargo is required to build the Rust gateway.");
    return 1;
  }
  if (result.error) {
    console.error(`Rust gateway build failed: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(buildGateway());
}
