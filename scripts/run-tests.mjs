import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = (await readdir(resolve(root, "tests")))
  .filter((name) => /\.test\.(ts|mjs)$/.test(name))
  .sort()
  .map((name) => `tests/${name}`);
if (!files.length) throw new Error("Не найдены тесты в tests/.");
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
