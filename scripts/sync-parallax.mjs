import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/core/config_store.mjs";
import { syncModelPolicy } from "../src/core/model_policy.mjs";

/** 使用指定插件数据目录同步公开目录，并将有效策略输出到 stdout。 */
async function main() {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
  if (!values["data-dir"]) throw new Error("用法：node scripts/sync-parallax.mjs --data-dir <目录>");
  const dataDir = path.resolve(values["data-dir"]);
  const policy = await syncModelPolicy(dataDir, loadConfig(dataDir));
  process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
  if (policy.syncError) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
