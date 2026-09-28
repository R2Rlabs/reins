#!/usr/bin/env node
/**
 * Puts `site/` on the web host, over FTPS, and checks the result.
 *
 *   node scripts/deploy-site.mjs [--dry-run]
 *
 * Credentials are never passed on the command line or kept in this repo: they
 * are read from a file outside it (default `%USERPROFILE%\.hostinger-ftp`, or
 * REINS_FTP_CONFIG), one `key = value` per line:
 *
 *   host = ftp.r2rlabs.com
 *   user = u123456789.deploy
 *   password = ...
 *   dir = /public_html          # optional, this is the default
 *
 * Nothing is printed from that file but the host and user, so a password
 * cannot end up in a terminal log. Uploads are FTPS (`--ssl-reqd`): plain FTP
 * would put the password on the wire in the clear.
 *
 * Afterwards every uploaded path is fetched from https://r2rlabs.com/ and its
 * length compared with the local file, because "the upload did not error" is
 * not the same as "the site serves it".
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("../", import.meta.url)));
const siteDir = join(root, "site");
const dryRun = process.argv.includes("--dry-run");
const configPath = process.env["REINS_FTP_CONFIG"] ?? join(homedir(), ".hostinger-ftp");
const PUBLIC_ORIGIN = "https://r2rlabs.com";

function readConfig() {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    console.error(`No credentials at ${configPath}.

Create that file with the FTP details from Hostinger (hPanel > Files > FTP
Accounts), one per line:

  host = ftp.r2rlabs.com
  user = u000000000.deploy
  password = the password you set there
  dir = /public_html

Then run this again. The file stays outside the repo and is never printed.`);
    process.exit(2);
  }
  const config = Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
      }),
  );
  for (const required of ["host", "user", "password"]) {
    if (!config[required]) {
      console.error(`${configPath} has no ${required}.`);
      process.exit(2);
    }
  }
  return { ...config, dir: config["dir"] ?? "/public_html" };
}

/** Every file under site/, as paths relative to it. */
function files(dir = siteDir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [relative(siteDir, full).split(sep).join("/")];
  });
}

const config = readConfig();
const list = files().sort();
console.error(`${dryRun ? "Would upload" : "Uploading"} ${list.length} files to ${config.user}@${config.host}${config.dir}`);

let failed = 0;
for (const path of list) {
  const target = `ftps://${config.host}${posix.join(config.dir, path)}`;
  if (dryRun) {
    console.error(`  - ${path}`);
    continue;
  }
  const result = spawnSync(
    "curl",
    ["--ssl-reqd", "--ftp-create-dirs", "--disable-epsv", "-sS", "-T", join(siteDir, path.split("/").join(sep)), target, "-u", `${config.user}:${config.password}`],
    { encoding: "utf8" },
  );
  const ok = result.status === 0;
  if (!ok) failed += 1;
  // The password lives in the argument list, so only curl's own message is shown.
  console.error(`  ${ok ? "✓" : "✗"} ${path}${ok ? "" : `: ${(result.stderr || "").trim().slice(0, 160)}`}`);
}

if (dryRun) process.exit(0);
if (failed > 0) {
  console.error(`\n${failed} file${failed === 1 ? "" : "s"} did not upload.`);
  process.exit(1);
}

// Uploaded is not the same as served.
console.error("\nChecking what the site actually serves:");
let wrong = 0;
for (const path of list) {
  const url = `${PUBLIC_ORIGIN}/${path.replace(/index\.html$/, "")}`;
  const local = statSync(join(siteDir, path.split("/").join(sep))).size;
  try {
    const res = await fetch(url, { redirect: "follow" });
    const served = (await res.arrayBuffer()).byteLength;
    const close = Math.abs(served - local) <= Math.max(16, local * 0.02);
    if (!res.ok || !close) wrong += 1;
    console.error(`  ${res.ok && close ? "✓" : "✗"} ${url} — ${res.status}, ${served} bytes (local ${local})`);
  } catch (error) {
    wrong += 1;
    console.error(`  ✗ ${url} — ${String(error)}`);
  }
}

console.error(wrong === 0 ? "\nLive and serving." : `\n${wrong} path${wrong === 1 ? "" : "s"} did not come back as expected.`);
process.exit(wrong === 0 ? 0 : 1);
