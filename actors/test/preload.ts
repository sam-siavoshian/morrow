// Regenerates the typed client from the current actor source before any test file imports it.
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

const actorsDir = resolve(import.meta.dir, "..")
const result = spawnSync(
    process.execPath,
    [join(actorsDir, "node_modules", "durable-actors", "bin", "durable-actors.js"), "generate", "src/actors.ts", "--out-dir", "generated"],
    { cwd: actorsDir, encoding: "utf8" }
)
if (result.status !== 0) throw new Error(`durable-actors generate failed:\n${result.stdout}\n${result.stderr}`)
