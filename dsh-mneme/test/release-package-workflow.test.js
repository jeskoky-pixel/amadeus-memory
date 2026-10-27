import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPrivacyCheck } from "../scripts/privacy-check.mjs";
import { finalizePackage, archiveInfo } from "../scripts/package-hash.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
mkdirSync(ROOT, { recursive: true });

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header[156] = 48;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function writeTarGz(file, files) {
  const chunks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    chunks.push(tarHeader(name, body.length), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(file, gzipSync(Buffer.concat(chunks)));
}

test("stale prior metadata + changed README rebuilds; final metadata matches archive; leaks still fail", () => {
  const fixture = join(ROOT, `release-workflow-${process.pid}-${Date.now()}`);
  const dist = join(fixture, "dist");
  const files = {
    "package/package.json": JSON.stringify({
      name: "@modusensus/dsh-mneme", version: "1.0.0",
      amadeus: { edition: "enhanced", upstream: "@modusensus/dsh-mneme@0.9.4" }
    }),
    "package/README.md": "changed README after the previous package\n",
    "package/src/qa-guard.js": "export {};\n",
    "package/src/backup.js": "export {};\n",
    "package/lib/qa-guard.js": "export {};\n",
    "package/lib/backup.js": "export {};\n",
    "package/docs/BACKUP_ROLLBACK.md": "# backup\n"
  };
  try {
    mkdirSync(join(fixture, "src"), { recursive: true });
    mkdirSync(join(fixture, "lib"), { recursive: true });
    mkdirSync(join(fixture, "docs"), { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(fixture, "package.json"), files["package/package.json"]);
    writeFileSync(join(fixture, "README.md"), files["package/README.md"]);
    for (const rel of ["src/qa-guard.js", "src/backup.js", "lib/qa-guard.js", "lib/backup.js", "lib/client.js"]) {
      writeFileSync(join(fixture, rel), "export {};\n");
    }
    writeFileSync(join(fixture, "docs", "BACKUP_ROLLBACK.md"), "# backup\n");
    // Stale metadata and stale tarball from before the README change.
    const tgz = join(dist, "modusensus-dsh-mneme-1.0.0.tgz");
    writeTarGz(tgz, files);
    writeFileSync(join(dist, "PACKAGE_INFO.json"), JSON.stringify({
      version: "1.0.0", bytes: 1, sha256: "0".repeat(64)
    }));

    const source = runPrivacyCheck({ root: fixture, sourceOnly: true, distDir: dist });
    assert.equal(source.ok, true, "source/prepack must ignore stale dist metadata");

    const info = finalizePackage({ root: fixture, distDir: dist, sourceHead: "synthetic-head", worktreeDirty: true });
    const actual = archiveInfo(tgz);
    assert.equal(info.sha256, actual.sha256);
    assert.equal(info.bytes, actual.bytes);
    assert.equal(info.files, actual.files);
    assert.equal(info.source_head, "synthetic-head");
    assert.equal(info.worktree_dirty, true);
    assert.equal(runPrivacyCheck({ root: fixture, sourceOnly: false, distDir: dist }).ok, true);

    // A packed credential/private path is still a hard failure even with fresh metadata.
    writeTarGz(tgz, {
      ...files,
      "package/leak.js": `const key = "sk-${"A".repeat(30)}";\nconst p = "C:\\\\Users\\\\${basename(homedir())}\\\\secret";\n`
    });
    const leak = runPrivacyCheck({ root: fixture, sourceOnly: false, distDir: dist });
    assert.equal(leak.ok, false);
    assert.ok(leak.problems.some((problem) => /credential pattern/.test(problem)));
  } finally {
    rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
