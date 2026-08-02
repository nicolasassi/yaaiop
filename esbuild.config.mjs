import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import fs from "fs";
import path from "path";

const prod = process.argv.includes("--production");

// Optional: set VAULT_PLUGIN_DIR to auto-copy the build into your vault.
const outDir = process.env.VAULT_PLUGIN_DIR || ".";

// The bundle is always written to the project root, then mirrored into the
// vault when VAULT_PLUGIN_DIR is set. Writing *only* to the vault would leave a
// stale main.js in the project, which is indistinguishable from a fresh one.
const copyStatics = {
  name: "copy-statics",
  setup(build) {
    build.onEnd(() => {
      if (outDir === ".") return;
      fs.mkdirSync(outDir, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) {
        fs.copyFileSync(f, path.join(outDir, f));
      }
      console.log(`copied build -> ${outDir}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian loads plugins as CommonJS.
  format: "cjs",
  target: "es2020",
  // Browser platform so esbuild resolves the SDK's browser entrypoints
  // (Obsidian mobile is a webview; there is no Node runtime there).
  platform: "browser",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    // Node built-ins, with and without the node: prefix. Nothing here is
    // reachable in a webview, but esbuild must be told not to bundle them.
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
  plugins: [copyStatics],
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
