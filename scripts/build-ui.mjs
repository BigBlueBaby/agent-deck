/**
 * AgentDeck 单文件看板构建脚本：
 * 使用 esbuild 将模块化前端（src/ui/main.mjs）与样式文件（src/ui/styles/*.css）
 * 内联打包为单个自包含 UTF-8 HTML 文件 dist/workbench.html，满足 Antigravity default-src 'none' CSP。
 *
 * @author AgentDeck Contributors
 * @since 2026-11-27
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function collectCss() {
  const stylesDir = path.join(ROOT, "src", "ui", "styles");
  if (fs.existsSync(stylesDir)) {
    const ordered = ["tokens.css", "layout.css", "components.css"];
    const allFiles = fs.readdirSync(stylesDir).filter((f) => f.endsWith(".css"));
    const sorted = [
      ...ordered.filter((f) => allFiles.includes(f)),
      ...allFiles.filter((f) => !ordered.includes(f)).sort(),
    ];
    return sorted.map((f) => fs.readFileSync(path.join(stylesDir, f), "utf8")).join("\n\n");
  }
  const singleCss = path.join(ROOT, "src", "ui", "styles.css");
  return fs.existsSync(singleCss) ? fs.readFileSync(singleCss, "utf8") : "";
}

async function main() {
  const entry = fs.existsSync(path.join(ROOT, "src", "ui", "main.mjs"))
    ? path.join(ROOT, "src", "ui", "main.mjs")
    : path.join(ROOT, "src", "ui", "app.mjs");

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    charset: "utf8",
    format: "iife",
    target: ["es2022"],
    write: false,
    platform: "browser",
  });

  const jsCode = result.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>");
  const cssCode = collectCss();

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AgentDeck</title>
  <style>${cssCode}</style>
</head>
<body>
  <div id="root"></div>
  <script>${jsCode}</script>
</body>
</html>
`;

  const distDir = path.join(ROOT, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const outPath = path.join(distDir, "workbench.html");
  fs.writeFileSync(outPath, html, "utf8");

  const sizeKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`Built self-contained AgentDeck UI: ${outPath} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error("Failed to build AgentDeck UI:", err);
  process.exit(1);
});
