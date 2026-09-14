import path from "node:path";
import fs from "fs-extra";
import { Command } from "commander";

const program = new Command();
program
  .requiredOption("--project <project>", "project key")
  .requiredOption("--type <type>", "web | api | app")
  .requiredOption("--module <module>", "business module")
  .option("--priority <priority>", "P0 | P1 | P2 | P3", "P1")
  .option("--scenario <scenario>", "scenario slug", "sample")
  .option("--owner <owner>", "case owner", "qa-name");
program.parse();

const opts = program.opts();
const caseId = `${opts.project}_${opts.type}_${opts.module}_${opts.scenario}_${opts.priority}_001`
  .replace(/[^a-zA-Z0-9_]/g, "_")
  .toLowerCase();
const targetDir = path.join(process.cwd(), "projects", opts.project, opts.type, "cases");
await fs.ensureDir(targetDir);
const target = path.join(targetDir, `${caseId}.case.yaml`);

const content = `id: ${caseId}
title: ${opts.module} ${opts.scenario}
type: ${opts.type}
project: ${opts.project}
module: ${opts.module}
priority: ${opts.priority}
tags:
  - smoke
  - regression
owner: ${opts.owner}
env:
  - test
automationCandidate: true
suggestedLayer: ${opts.type}
steps:
  - action: TODO
    target: TODO
    riskLevel: low
assertions:
  - type: TODO
    target: TODO
`;

await fs.writeFile(target, content, { flag: "wx" });
console.log(`Generated case: ${target}`);
