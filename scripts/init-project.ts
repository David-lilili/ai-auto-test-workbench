import path from "node:path";
import fs from "fs-extra";
import { Command } from "commander";

const program = new Command();
program.requiredOption("--project <project>", "new project key");
program.option("--name <name>", "display name");
program.parse();

const opts = program.opts();
const projectKey = String(opts.project);
const displayName = String(opts.name ?? projectKey);

const root = process.cwd();
const configDir = path.join(root, "configs", "projects", projectKey);
const projectDir = path.join(root, "projects", projectKey);

await fs.ensureDir(configDir);
await fs.ensureDir(path.join(projectDir, "web", "cases"));
await fs.ensureDir(path.join(projectDir, "app", "cases"));
await fs.ensureDir(path.join(projectDir, "api", "cases"));
await fs.ensureDir(path.join(projectDir, "data", "fixtures"));
await fs.ensureDir(path.join(projectDir, "docs"));

await fs.writeFile(
  path.join(configDir, "project.config.yaml"),
  [
    `projectKey: ${projectKey}`,
    `projectName: ${displayName}`,
    "owners:",
    "  - qa-team",
    "enabledTestTypes:",
    "  - web",
    "  - api",
    "  - app",
    "defaultEnv: test",
    "report:",
    "  html: true",
    "  aiSummary: true",
    "failureArtifacts:",
    "  screenshot: true",
    "  video: true",
    "  trace: true",
    ""
  ].join("\n"),
  { flag: "wx" }
).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "EEXIST") throw error;
});

console.log(`Project initialized: ${projectKey}`);
