import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This is a conservative publication gate, not a substitute for rotating leaked
// credentials or for a provider-supported scan of the entire Git history.
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([
  ".git", ".next", ".vercel", ".firebase", ".turbo", ".cache", ".npm-cache",
  ".pnpm-store", "node_modules", "coverage", "playwright-report",
  "test-results", "out", "dist",
]);
const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".webm", ".zip",
]);
const maxTextBytes = 5 * 1024 * 1024;
const patterns = [
  ["private-key material", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ["service-account credentials", /["']type["']\s*:\s*["']service_account["']/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["OpenAI-style secret key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ["Stripe secret key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["Google OAuth credential", /\b(?:GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{30,})\b/g],
  ["npm access token", /\bnpm_[A-Za-z0-9]{36,}\b/g],
  ["Vercel access token", /\bvcp_[A-Za-z0-9_-]{30,}\b/g],
  ["JWT credential", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g],
  ["URL with embedded credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{8,}@/gi],
];

function scanText(content) {
  const found = [];
  const add = (name, position) => found.push({
    name,
    line: content.slice(0, position).split("\n").length,
  });

  for (const [name, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) add(name, match.index);
  }

  // NEXT_PUBLIC Firebase web configuration is intentionally public. The
  // application does not use administrator credentials in any environment.
  const assignment = /\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)|access_token|refresh_token|client_secret|password|private_key)["']?\s*[:=]\s*["']?([^\s"'`,;}{]+)/gi;
  for (const match of content.matchAll(assignment)) {
    const [, key, value] = match;
    if (key.startsWith("NEXT_PUBLIC_")) continue;
    if (value.length < 12) continue;
    if (/^(?:process\.|import\.|env\.|\$|<|your[-_]|example|replace[-_]|placeholder|test[-_]|demo[-_]|undefined|null)/i.test(value)) continue;
    if (/^[A-Z][A-Z0-9_]*$/.test(value)) continue;
    if (!/[A-Za-z]/.test(value) || !/[0-9_+\-/=]/.test(value)) continue;
    add("hard-coded sensitive assignment", match.index);
  }
  return found;
}

function normalize(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function git(...args) {
  return execFileSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function isIgnoredDirectory(path) {
  return path.split(/[\\/]/).slice(0, -1).some((part) => ignoredDirectories.has(part));
}

function isPrivateEnvironment(path) {
  const name = basename(path);
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

function isCredentialPath(path) {
  return /(?:^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/\\]*(?:service[-_]?account|firebase[-_]?adminsdk)[^/\\]*\.json)$/i.test(path)
    || /\.(?:pem|p12|pfx|key|jks)$/i.test(path);
}

function isBinaryPath(path) {
  return binaryExtensions.has(extname(path).toLowerCase()) || path.endsWith(".tsbuildinfo");
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) paths.push(...await walk(absolute));
    } else if (!isPrivateEnvironment(entry.name) && !entry.name.endsWith(".log")) {
      paths.push(relative(projectRoot, absolute).split(sep).join("/"));
    }
  }
  return paths;
}

function runSelfTest() {
  const dummyGithub = ["ghp", "_", "a".repeat(36)].join("");
  const dummyPem = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const dummyServiceAccount = JSON.stringify({ type: ["service", "account"].join("_") });
  const dummyAssignment = ["VERCEL", "TOKEN"].join("_") + "=a1".repeat(14);
  const checks = [
    scanText(dummyGithub).some((item) => item.name === "GitHub token"),
    scanText(dummyPem).some((item) => item.name === "private-key material"),
    scanText(dummyServiceAccount).some((item) => item.name === "service-account credentials"),
    scanText(dummyAssignment).some((item) => item.name === "hard-coded sensitive assignment"),
    scanText("NEXT_PUBLIC_FIREBASE_API_KEY=example-public-config").length === 0,
    scanText("VERCEL_TOKEN=your-token-here").length === 0,
    scanText("const secret = process.env.CLIENT_SECRET;").length === 0,
    scanText("first line\n" + dummyGithub)[0]?.line === 2,
    isPrivateEnvironment(".env.local") && !isPrivateEnvironment(".env.example"),
    isCredentialPath("service-account.json") && isCredentialPath("signing.pem"),
    isIgnoredDirectory("node_modules/example/index.js") && !isIgnoredDirectory("src/index.ts"),
  ];
  if (checks.some((passed) => !passed)) {
    console.error("Secret scanner self-test failed; no fixture values are printed.");
    process.exitCode = 1;
  } else {
    console.log(`Secret scanner self-test passed (${checks.length} checks).`);
  }
}

async function runScan() {
  const findings = [];
  const add = (path, source, name, line = 1) => findings.push({ path, source, name, line });
  let independentGit = false;
  try {
    independentGit = normalize(git("rev-parse", "--show-toplevel").trim()) === normalize(projectRoot);
  } catch {
    // Before git init, scan this project only; never scan its parent repository.
  }

  let indexEntries = [];
  let workingPaths;
  if (independentGit) {
    indexEntries = git("ls-files", "--stage", "-z").split("\0").filter(Boolean).map((entry) => {
      const splitAt = entry.indexOf("\t");
      const [mode, , stage] = entry.slice(0, splitAt).split(" ");
      return { path: entry.slice(splitAt + 1), mode, stage };
    });
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    workingPaths = [...new Set([...indexEntries.map((entry) => entry.path), ...untracked])];
  } else {
    workingPaths = await walk(projectRoot);
  }

  let workingCount = 0;
  let indexCount = 0;
  const scanBuffer = (path, source, buffer) => {
    if (buffer.includes(0)) return false;
    if (buffer.length > maxTextBytes) {
      add(path, source, "text file exceeds scanner size limit; manual review required");
      return false;
    }
    for (const finding of scanText(buffer.toString("utf8"))) {
      add(path, source, finding.name, finding.line);
    }
    return true;
  };

  for (const path of workingPaths.sort()) {
    if (isPrivateEnvironment(path)) {
      add(path, "working tree", "private environment file is not excluded from publication");
      continue;
    }
    if (isIgnoredDirectory(path) || isBinaryPath(path)) continue;
    if (isCredentialPath(path)) {
      add(path, "working tree", "credential file must not be published");
      continue;
    }
    const absolute = resolve(projectRoot, path);
    if (!normalize(absolute).startsWith(normalize(projectRoot) + sep)) {
      add(path, "working tree", "path escapes project directory");
      continue;
    }
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        add(path, "working tree", "non-regular file requires manual publication review");
        continue;
      }
      if (scanBuffer(path, "working tree", await readFile(absolute))) workingCount += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") add(path, "working tree", "file could not be scanned");
      // A deleted working file may still exist in the index; scan that below.
    }
  }

  for (const { path, mode, stage } of indexEntries) {
    if (isPrivateEnvironment(path) || isCredentialPath(path)) {
      add(path, "Git index", "private environment or credential file is tracked");
      continue;
    }
    if (isIgnoredDirectory(path)) {
      add(path, "Git index", "dependency/build/private-tool directory must not be tracked");
      continue;
    }
    if (stage !== "0" || !["100644", "100755"].includes(mode)) {
      add(path, "Git index", "unmerged or non-regular index entry requires review");
      continue;
    }
    if (isBinaryPath(path)) continue;
    try {
      if (scanBuffer(path, "Git index", Buffer.from(git("show", `:${path}`), "utf8"))) indexCount += 1;
    } catch {
      add(path, "Git index", "staged blob could not be scanned");
    }
  }

  if (findings.length > 0) {
    console.error(`Secret scan failed: ${findings.length} finding(s). Values are never printed.`);
    for (const item of findings) {
      console.error(`- ${item.path}:${item.line} [${item.source}] ${item.name}`);
    }
    console.error("Remove private data from both the working tree and Git index. Rotate any exposed credentials.");
    process.exitCode = 1;
    return;
  }
  console.log(`Secret scan passed: ${workingCount} working-tree text files; ${indexCount} Git-index text blobs.`);
  console.log(independentGit
    ? "Scope: publishable source and staged content. Git history and binary assets are not scanned."
    : "No independent Git repository yet: scanned project source only, excluding local environment files and generated assets.");
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  try {
    await runScan();
  } catch {
    console.error("Secret scan could not complete. No credential values are printed.");
    process.exitCode = 1;
  }
}
