// The pinned tools: every version that a workflow or a script runs is in a place that
// Dependabot reads, so that a pull request brings each new one. The actions of the
// workflows, the packages of npm in a package.json with its package-lock.json, and the
// images in the FROM of a Dockerfile; a version anywhere else would age silently in the
// template and in every control repository that takes it.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPENDABOT = ".github/dependabot.yml";
// The folders that hold no file of the repository.
const SKIPPED = new Set([".git", "node_modules", "coverage", "pager-input"]);

// The commands that fetch a tool by its name and version, past every lock file.
const DOWNLOADS = [
  [
    /\b(?:npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx|pipx\s+run)\b/,
    "fetches a package",
  ],
  [
    /\bnpm\s+(?:exec|x|install|i|add)\b.*\s(?:@[\w.-]+\/)?[\w.-]+@\d/,
    "installs a package by its version, past package-lock.json",
  ],
  [/\bpip3?\s+install\b.*==/, "installs a package by its version"],
  [/\bgo\s+(?:install|run)\b.*@v?\d/, "installs a module by its version"],
  [/@sha256:[0-9a-f]{64}/, "pins an image"],
  [/\bdocker:\/\//, "runs an image as an action"],
  [/^\s*image:\s*\S/, "runs a job in an image"],
];

/** The files below a folder of the repository, without those of npm or git. */
function filesBelow(folder) {
  const start = join(ROOT, folder);
  if (!existsSync(start)) return [];
  return readdirSync(start, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory())
      return SKIPPED.has(entry.name) ? [] : filesBelow(path);
    return [path.split("\\").join("/")];
  });
}

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Each line of a text that fetches or pins a tool where no updater reads it. */
function pinsIn(path, text) {
  return text
    .split("\n")
    .flatMap((line, index) =>
      DOWNLOADS.filter(([pattern]) => pattern.test(line)).map(
        ([, what]) => `${path}:${index + 1}: ${what}: ${line.trim()}`,
      ),
    );
}

/** The folders of each ecosystem of a dependabot.yml, as /path. */
function updatersOf(text) {
  const updaters = new Map();
  for (const block of text.split(/^\s*-\s+(?=package-ecosystem:)/m).slice(1)) {
    const ecosystem = block.match(/^package-ecosystem:\s*["']?([\w-]+)/)[1];
    const single = block.match(/^\s*directory:\s*["']?([^"'\s]+)/m);
    const many = block.match(/^\s*directories:\s*\[([^\]]*)\]/m);
    const folders = [
      ...(single ? [single[1]] : []),
      ...(many
        ? many[1]
            .split(",")
            .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
        : []),
    ].map((folder) => `/${folder.replace(/^\/+|\/+$/g, "")}`);
    updaters.set(
      ecosystem,
      new Set([...(updaters.get(ecosystem) ?? []), ...folders]),
    );
  }
  return updaters;
}

/** The folder of a file of the repository, as Dependabot names it. */
function folderOf(path) {
  const folder = dirname(path);
  return folder === "." ? "/" : `/${folder}`;
}

/** The image of the FROM of a Dockerfile, or null. */
function imageOf(text) {
  return text.match(/^FROM\s+(\S+)/m)?.[1] ?? null;
}

describe("finding a pinned tool", () => {
  it("finds the commands that fetch a tool by its version", () => {
    const text = [
      "run: npx --yes @biomejs/biome@2.6.4 ci .",
      'answer="$(npm exec --yes @anthropic-ai/claude-code@2.1.317 -p hi)"',
      "run: pip install zizmor==1.31.1",
      "run: go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12",
      `  ACTIONLINT: rhysd/actionlint:1.7.12@sha256:${"b".repeat(64)}`,
      "  - uses: docker://alpine:3",
      "    image: node:24",
    ].join("\n");
    assert.deepEqual(
      pinsIn("x.yml", text).map((found) =>
        found.split(":").slice(0, 2).join(":"),
      ),
      [
        "x.yml:1",
        "x.yml:2",
        "x.yml:3",
        "x.yml:4",
        "x.yml:5",
        "x.yml:6",
        "x.yml:7",
      ],
    );
  });

  it("leaves the commands that take a tool from a lock file or a Dockerfile", () => {
    const text = [
      "run: npm ci --ignore-scripts",
      "run: npm test && npm run lint",
      "run: .github/tools/claude-code/node_modules/.bin/claude -p hi",
      `image="$(awk '$1 == "FROM" { print $2; exit }' .github/tools/zizmor.Dockerfile)"`,
      'docker run --rm --volume "$PWD:/repo" --workdir /repo "$image"',
      "- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    ].join("\n");
    assert.deepEqual(pinsIn("x.yml", text), []);
  });

  it("reads the folders of each ecosystem of Dependabot", () => {
    const updaters = updatersOf(
      [
        "version: 2",
        "updates:",
        "  - package-ecosystem: github-actions",
        "    directory: /",
        '  - package-ecosystem: "npm"',
        '    directories: ["/", "/.github/tools/claude-code/"]',
        "  - package-ecosystem: docker",
        "    directory: .github/tools",
      ].join("\n"),
    );
    assert.deepEqual(
      Object.fromEntries(
        [...updaters].map(([name, folders]) => [name, [...folders]]),
      ),
      {
        "github-actions": ["/"],
        npm: ["/", "/.github/tools/claude-code"],
        docker: ["/.github/tools"],
      },
    );
  });
});

// The template keeps the pins; a control repository takes them from it through the
// workflow Template, deletes its dependabot.yml, as the README says, or keeps one of
// its own, and has nothing of this to check.
const template =
  JSON.parse(read(".github/template.json")).commit === "" &&
  existsSync(join(ROOT, DEPENDABOT));

describe("the pins of this repository", {
  skip: !template && "a control repository takes its pins from the template",
}, () => {
  const updaters = template ? updatersOf(read(DEPENDABOT)) : new Map();
  const reads = (ecosystem, folder) =>
    updaters.get(ecosystem)?.has(folder) ?? false;
  const runs = [...filesBelow(".github/workflows"), ...filesBelow("scripts")];
  const packages = ["package.json", ...filesBelow(".github/tools")].filter(
    (path) => path.endsWith("package.json"),
  );
  const dockerfiles = filesBelow(".").filter((path) =>
    /dockerfile/i.test(path.split("/").pop()),
  );

  it("pins no tool in a workflow or a script, where no updater reads it", () => {
    const scripts = Object.entries(
      JSON.parse(read("package.json")).scripts ?? {},
    );
    const found = [
      ...runs.flatMap((path) => pinsIn(path, read(path))),
      ...scripts.flatMap(([name, command]) =>
        pinsIn(`package.json, script ${name}`, command),
      ),
    ];
    assert.deepEqual(
      found,
      [],
      "move each into a package.json or a Dockerfile of .github/tools/",
    );
  });

  it("has Dependabot keep the actions of the workflows current", () => {
    assert.ok(
      reads("github-actions", "/"),
      `${DEPENDABOT} has no github-actions for /`,
    );
  });

  it("has Dependabot keep each package.json current, by its exact versions in its lock", () => {
    assert.ok(packages.length > 0);
    for (const path of packages) {
      const folder = folderOf(path);
      assert.ok(reads("npm", folder), `${DEPENDABOT} has no npm for ${folder}`);
      const lockPath = join(dirname(path), "package-lock.json");
      assert.ok(
        existsSync(join(ROOT, lockPath)),
        `${path} has no package-lock.json`,
      );
      const lock = JSON.parse(read(lockPath));
      const manifest = JSON.parse(read(path));
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ]) {
        for (const [name, version] of Object.entries(manifest[field] ?? {})) {
          assert.match(
            version,
            /^\d+\.\d+\.\d+(?:-[\w.]+)?$/,
            `${path}: ${name} isn't exact`,
          );
          assert.equal(
            lock.packages[`node_modules/${name}`]?.version,
            version,
            `${lockPath} doesn't lock ${name} ${version}: run npm install`,
          );
        }
      }
    }
  });

  it("has Dependabot keep each image current, by its tag and its digest", () => {
    assert.ok(dockerfiles.length > 0);
    for (const path of dockerfiles) {
      assert.ok(
        reads("docker", folderOf(path)),
        `${DEPENDABOT} has no docker for ${folderOf(path)}`,
      );
      assert.match(
        imageOf(read(path)) ?? "",
        /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/,
        `${path} pins no image by its tag and its digest`,
      );
    }
  });

  it("runs the image of every Dockerfile, and names none that is missing", () => {
    const named = new Set(
      runs.flatMap((path) => read(path).match(/[\w./-]+\.Dockerfile\b/g) ?? []),
    );
    for (const path of named) {
      assert.ok(
        existsSync(join(ROOT, path)),
        `${path} is named, but doesn't exist`,
      );
    }
    for (const path of dockerfiles) {
      assert.ok(
        named.has(path),
        `no workflow or script runs the image of ${path}`,
      );
    }
  });
});
