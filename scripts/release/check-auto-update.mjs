import { execFileSync } from "node:child_process";

// A local macOS/Linux release command cannot substitute for Windows/SCM acceptance.
// Require all six native runs for the exact main commit before creating a release tag.
const sha = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
  throw new Error("Usage: node scripts/release/check-auto-update.mjs <main-commit-sha>");
}
const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
const repository = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
const api = (path) => JSON.parse(gh(["api", `repos/${repository}/${path}`]));
const runs = api(`actions/workflows/main.yml/runs?head_sha=${sha}&per_page=20`).workflow_runs;
const run = runs.find(
  (item) => item.head_sha === sha && item.head_branch === "main" && item.event === "push",
);
if (!run)
  throw new Error(`No Main Verification run exists for ${sha}; wait for main CI before releasing`);
const jobs = api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs;
const missing = [];
for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
  for (const mode of ["daemon", "system"]) {
    const name = `Native automatic update (${os}, ${mode})`;
    const job = jobs.find((item) => item.name === name || item.name.endsWith(` / ${name}`));
    if (job?.status !== "completed" || job.conclusion !== "success")
      missing.push(`${name}: ${job?.conclusion ?? job?.status ?? "missing"}`);
  }
}
if (missing.length)
  throw new Error(
    `Automatic update acceptance has not passed for ${sha}:\n${missing.join("\n")}\n${run.html_url}`,
  );
console.log(`Native automatic update passed on all platforms and service modes: ${run.html_url}`);
