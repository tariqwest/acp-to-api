#!/usr/bin/env node
/**
 * Generate a Homebrew formula for acp-to-api.
 *
 * Usage:
 *   bun scripts/generate-homebrew-formula.mjs [version] [options]
 *   bun run formula [version] [options]
 *
 * Examples:
 *   bun run formula 0.1.0
 *   bun run formula 0.1.0 -- --sha256 abc...
 *   bun run formula 0.1.0 -- --write ./Formula/acp-to-api.rb
 *   bun run formula 0.1.0 -- --source github
 *   bun run formula 0.1.0 -- --source npm
 *
 * Options:
 *   --sha256 HEX           Use this sha256 (otherwise fetch tarball and hash)
 *   --source github|npm    Tarball source (default: github)
 *   --repo OWNER/NAME      GitHub repo (default: from package.json / gh)
 *   --write PATH           Write formula to PATH instead of stdout
 *   --class NAME           Formula class name (default: AcpToApi)
 *   --help, -h
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PACKAGE_JSON = path.join(ROOT, "package.json");

function usage(code = 0) {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const block = text.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
  console.log(
    block
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").replace(/^\s*$/, ""))
      .join("\n")
      .trim(),
  );
  process.exit(code);
}

function fail(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    version: null,
    sha256: null,
    source: "github",
    repo: null,
    write: null,
    className: "AcpToApi",
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--help" || a === "-h") usage(0);
    if (a === "--sha256") {
      opts.sha256 = argv[++i];
      if (!opts.sha256) fail("--sha256 requires a value");
      continue;
    }
    if (a.startsWith("--sha256=")) {
      opts.sha256 = a.slice("--sha256=".length);
      continue;
    }
    if (a === "--source") {
      opts.source = argv[++i];
      continue;
    }
    if (a.startsWith("--source=")) {
      opts.source = a.slice("--source=".length);
      continue;
    }
    if (a === "--repo") {
      opts.repo = argv[++i];
      continue;
    }
    if (a.startsWith("--repo=")) {
      opts.repo = a.slice("--repo=".length);
      continue;
    }
    if (a === "--write") {
      opts.write = argv[++i];
      continue;
    }
    if (a.startsWith("--write=")) {
      opts.write = a.slice("--write=".length);
      continue;
    }
    if (a === "--class") {
      opts.className = argv[++i];
      continue;
    }
    if (a.startsWith("--class=")) {
      opts.className = a.slice("--class=".length);
      continue;
    }
    if (a.startsWith("-")) fail(`unknown option: ${a}`);
    positionals.push(a);
  }
  if (positionals.length > 1) fail("expected at most one version argument");
  opts.version = positionals[0] ?? null;
  if (opts.source !== "github" && opts.source !== "npm") {
    fail(`--source must be github or npm (got ${opts.source})`);
  }
  return opts;
}

function readPackage() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

function resolveRepo(explicit) {
  if (explicit) {
    return explicit
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
  }
  const pkg = readPackage();
  const url = pkg.repository?.url || pkg.repository;
  if (typeof url === "string") {
    const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?/);
    if (m) return m[1];
  }
  const gh = capture("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  if (gh.status === 0 && gh.stdout) return gh.stdout;
  fail("could not resolve GitHub repo; pass --repo owner/name");
}

function tarballUrl({ source, repo, name, version }) {
  if (source === "npm") {
    // Scoped packages use different URL shape; acp-to-api is unscoped.
    const base = name.startsWith("@")
      ? `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`
      : `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    return base;
  }
  return `https://github.com/${repo}/archive/refs/tags/v${version}.tar.gz`;
}

async function sha256OfUrl(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`failed to download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return createHash("sha256").update(buf).digest("hex");
}

function rubyEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderFormula({
  className,
  name,
  desc,
  homepage,
  license,
  url,
  sha256,
  repo,
}) {
  return `# typed: false
# frozen_string_literal: true

class ${className} < Formula
  desc "${rubyEscape(desc)}"
  homepage "${rubyEscape(homepage)}"
  url "${rubyEscape(url)}"
  sha256 "${sha256}"
  license "${rubyEscape(license)}"
  head "https://github.com/${repo}.git", branch: "main"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  service do
    run [opt_bin/"acp-to-api"]
    keep_alive true
    require_root false
    log_path var/"log/acp-to-api.log"
    error_log_path var/"log/acp-to-api.error.log"
    working_dir HOMEBREW_PREFIX
    environment_variables ACP_TO_API_HOST: "127.0.0.1", ACP_TO_API_PORT: "8787"
  end

  def caveats
    <<~EOS
      acp-to-api is an OpenAI-compatible REST gateway for local ACP agents.

      Start the server:

        #{bin}/acp-to-api

      Or run it as a managed service with Homebrew services:

        brew services start acp-to-api
        brew services stop acp-to-api
        brew services restart acp-to-api

      Defaults to http://127.0.0.1:8787. Useful env vars:

        ACP_TO_API_HOST
        ACP_TO_API_PORT
        ACP_TO_API_TOKEN
        ACP_TO_API_CWD
        ACP_TO_API_PERMISSION_MODE

      Install one or more ACP agents on PATH (opencode, devin, oz-acp, agy-acp, fm-acp).
      Prefer Bun when available; Node uses the bundled tsx loader.
    EOS
  end

  test do
    assert_path_exists bin/"acp-to-api"
    pkg_json = libexec/"lib/node_modules/${name}/package.json"
    assert_path_exists pkg_json
    assert_match version.to_s, pkg_json.read
  end
end
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = readPackage();
  const version = (opts.version || pkg.version || "").replace(/^v/, "");
  if (!version) fail("version required (arg or package.json)");
  const name = pkg.name || "acp-to-api";
  const repo = resolveRepo(opts.repo);
  const homepage = pkg.homepage || `https://github.com/${repo}`;
  const desc =
    pkg.description ||
    "OpenAI-compatible REST gateway for local ACP agents";
  const license = pkg.license || "MIT";
  const url = tarballUrl({ source: opts.source, repo, name, version });

  let sha256 = opts.sha256;
  if (!sha256) {
    process.stderr.write(`fetching ${url} ... `);
    sha256 = await sha256OfUrl(url);
    process.stderr.write(`${sha256}\n`);
  }

  const formula = renderFormula({
    className: opts.className,
    name,
    desc,
    homepage,
    license,
    url,
    sha256,
    repo,
  });

  if (opts.write) {
    const out = path.resolve(opts.write);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, formula, "utf8");
    process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(formula);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
