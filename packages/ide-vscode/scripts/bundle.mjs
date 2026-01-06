import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Use fileURLToPath to correctly handle spaces and other URL-encoded characters in paths.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

await build({
  entryPoints: [path.join(root, "src", "extension.ts")],
  outfile: path.join(root, "dist", "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: ["node16"],
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info"
});


