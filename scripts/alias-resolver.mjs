/*
 * Resolver hooks that make app modules importable from a plain Node script.
 *
 * Three differences between Next's resolution and Node's have to be bridged,
 * and all three are the kind that fail loudly rather than subtly, which is why
 * this is worth doing instead of duplicating the code into the script:
 *
 *   1. `@/x`        → `src/x`          (tsconfig `paths`)
 *   2. `./names`    → `./names.ts`     (TypeScript's extensionless imports)
 *   3. `server-only` → a no-op         (the package exists only to THROW when
 *                                       imported outside a server component;
 *                                       a script is exactly as server-side as
 *                                       a route handler, so the guard is
 *                                       meaningless here rather than violated)
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = pathToFileURL(path.resolve("src") + "/").href;
const EXTS = [".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, next) {
  if (specifier === "server-only" || specifier === "client-only") {
    return { url: pathToFileURL(path.resolve("scripts/noop-module.mjs")).href, shortCircuit: true };
  }

  let spec = specifier;
  if (spec.startsWith("@/")) spec = SRC + spec.slice(2);

  try {
    return await next(spec, context);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    // Extensionless TypeScript import: try the extensions Next would.
    const base = spec.startsWith("file:") ? spec
      : spec.startsWith(".") && context.parentURL
        ? new URL(spec, context.parentURL).href
        : null;
    if (!base) throw err;
    for (const ext of EXTS) {
      const candidate = base + ext;
      if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
    }
    throw err;
  }
}
