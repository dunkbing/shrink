import { expect, test } from "bun:test";
import { createTools, resolve, runCommand } from "../src";
import { scriptTool } from "./lib/platform";

const live = () => new AbortController().signal;
// the test commands are bun scripts, which exist on every OS
const bun = process.execPath;
const sleep = [bun, "-e", "setTimeout(() => {}, 5000)"];

test("runCommand returns output and the exit code", async () => {
  const r = await runCommand([bun, "-e", 'console.log("hi"); console.error("err"); process.exit(3)'], { signal: live(), timeoutMs: 5000 });
  expect(r).toEqual({ code: 3, stdout: "hi\n", stderr: "err\n" });
});

test("runCommand kills a command that runs too long", async () => {
  const t0 = performance.now();
  await expect(runCommand(sleep, { signal: live(), timeoutMs: 100 })).rejects.toThrow("timed out");
  expect(performance.now() - t0).toBeLessThan(2000);
});

test("runCommand stops when cancelled", async () => {
  const ac = new AbortController();
  const run = runCommand(sleep, { signal: ac.signal, timeoutMs: 10000 });
  setTimeout(() => ac.abort(), 50);
  await expect(run).rejects.toThrow("cancelled");
});

test("arguments that look like options are passed as they are", async () => {
  const r = await runCommand([...scriptTool('process.stdout.write(args.join(" "))'), "-n", "--version"], { signal: live(), timeoutMs: 5000 });
  expect(r.stdout).toBe("-n --version");
});

test("tools are found in toolPaths first, then PATH, and can be disabled", async () => {
  const s = resolve({ toolPaths: { fancy: ["wine", "fancy.exe"] }, disabledTools: ["bun"] });
  const t = createTools(s);
  expect(await t.locate("fancy")).toEqual(["wine", "fancy.exe"]);
  expect(await t.locate("bun")).toBeNull(); // disabled
  expect(await createTools(resolve()).locate("bun")).not.toBeNull();
  expect(await t.locate("no-such-tool-shrink")).toBeNull();
});
