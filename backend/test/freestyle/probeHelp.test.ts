// probe.sh decides whether a CLI has a `status` subcommand from its --help text. Cursor Agent lists it as
// `status|whoami [options]`; missing that made a signed-in Cursor read as signed out.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PROBE = join(import.meta.dir, "../../vm/probe.sh");

async function hasSubcommand(help: string, name: string): Promise<boolean> {
  const script = await Bun.file(PROBE).text();
  const fn = script.match(/^has_subcommand\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  if (!fn) throw new Error("has_subcommand not found in probe.sh");
  const proc = Bun.spawn(["bash", "-c", `${fn}\nhas_subcommand "$1" "$2"`, "probe", help, name], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

describe("probe.sh has_subcommand", () => {
  test.each([
    ["  status|whoami [options]      View authentication status", true],
    ["  whoami|status  View authentication status", true],
    ["  status [options]  Show status", true],
    ["  status", true],
    ["Commands:\n  login  Sign in\n  status  Show status", true],
    ["  statusbar   Not it", false],
    ["  xstatus|y   Not it", false],
    ["  login|logout  Auth", false],
    ["status at column zero is prose, not a command", false],
  ])("%p -> %p", async (help, expected) => {
    expect(await hasSubcommand(help, "status")).toBe(expected);
  });
});
