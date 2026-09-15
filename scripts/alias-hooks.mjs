/*
 * Lets a plain `node scripts/*.mjs` import application modules that use the
 * `@/…` path alias.
 *
 * Next resolves `@/x` to `src/x` through tsconfig `paths`; Node knows nothing
 * about that and fails with ERR_MODULE_NOT_FOUND. Rather than fork the app
 * code into scripts — which is how a test starts silently checking something
 * other than what ships — this teaches Node the same single rule.
 *
 * Used as: node --import ./scripts/alias-hooks.mjs scripts/whatever.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-resolver.mjs", pathToFileURL("./scripts/"));
