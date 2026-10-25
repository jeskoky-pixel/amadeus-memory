import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const file = join("..", "dist", `modusensus-dsh-mneme-${pkg.version}.tgz`);
if (!existsSync(file)) {
  console.error(`missing package: ${file}`);
  process.exitCode = 1;
} else {
  const bytes = readFileSync(file);
  console.log(JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    file,
    bytes: statSync(file).size,
    sha256: createHash("sha256").update(bytes).digest("hex")
  }, null, 2));
}
