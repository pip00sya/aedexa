import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm");
const destination = resolve(root, "public/libredwg/libredwg-web.wasm");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
