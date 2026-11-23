const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workflows = fs.readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, fs.readFileSync(path.join(".github/workflows", name), "utf8")]);

test("every third-party GitHub Action is pinned to a full commit SHA", () => {
  for (const [name, text] of workflows)
    for (const [, ref] of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
      if (ref.startsWith("./")) continue;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${name}: ${ref} must be pinned to a commit SHA`);
    }
});

test("the host contract job names the Decaid revision it actually checks out", () => {
  const ci = workflows.find(([name]) => name === "ci.yml")[1];
  const job = ci.slice(ci.indexOf("  host-contract:"));
  const ref = /repository: decentespresso\/decaid\s+ref: (\S+)/.exec(job)[1];
  const title = /name: (.+)/.exec(job)[1];
  if (/^[0-9a-f]{40}$/.test(ref)) assert.match(title, /pinned/i);
  else {
    assert.doesNotMatch(title, /pinned/i, "a branch ref is not a pinned host");
    assert.match(title, new RegExp(ref));
    assert.match(job, /git rev-parse HEAD/, "the tested upstream SHA must be recorded");
  }
});

test("the simulator job uses the read-only research deploy key and says when it is skipped", () => {
  const ci = workflows.find(([name]) => name === "ci.yml")[1];
  const job = ci.slice(ci.indexOf("  e64-simulator:"), ci.indexOf("  host-contract:"));
  assert.match(job, /repository: MaxRink\/mahlkoenig-e64ws-local-research\s+ssh-key: \$\{\{ secrets\.RESEARCH_REPO_SSH_KEY \}\}\s+path: research\s+persist-credentials: false/);
  assert.match(job, /repository: MaxRink\/decaid-e64ws-plugin\s+ref: c3e363d7cd4f396f3a2b19c9e4e361e58199a26f/);
  assert.match(job, /repository: MaxRink\/decaid\s+ref: a0dede246cd5a65601bf24bc79b77d5778b78fc6\s+ssh-key: \$\{\{ secrets\.DECAID_FORK_SSH_KEY \}\}\s+path: decaid-host\s+persist-credentials: false/);
  assert.match(job, /flutter-version: 3\.47\.9/);
  assert.match(job, /if: env\.HAS_RESEARCH_KEY != 'true'[\s\S]*::warning title=E64 simulator tests skipped::/);
  const browsers = ci.slice(ci.indexOf("  browsers:"), ci.indexOf("  javascript:"));
  assert.match(browsers, /E64_SIM_OPTIONAL: '1'/, "jobs without the private simulator must mark it optional");
});

test("no private simulator code or captures are vendored into this public repository", () => {
  const { execFileSync } = require("node:child_process");
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n");
  assert.deepEqual(tracked.filter((file) => /e64ws_simulator|grind_capture|captures\/|grind-2026\d+/.test(file)), []);
});

test("the vendored plugin-ui kit is unedited and CI checks it against a pinned kit commit", () => {
  const source = fs.readFileSync("plugin.js", "utf8");
  const block = /\/\* plugin-ui:begin \*\/\nconst PLUGIN_UI = (.*);\n\/\* plugin-ui:end \*\//.exec(source);
  assert.ok(block, "plugin.js keeps the vendor.mjs marker block");
  const kit = JSON.parse(block[1]);
  const sha = (text) => require("node:crypto").createHash("sha256").update(text, "utf8").digest("hex");
  assert.deepEqual({ css: sha(kit.css), js: sha(kit.js) }, kit.sha256, "re-run vendor.mjs inject instead of editing the copy");
  const ci = workflows.find(([name]) => name === "ci.yml")[1];
  assert.match(ci, /raw\.githubusercontent\.com\/MaxRink\/streamline-js\/[0-9a-f]{40}\/docs\/plugin-ui/);
  assert.match(ci, /vendor\.mjs" check plugin\.js "\$KIT"/);
});
