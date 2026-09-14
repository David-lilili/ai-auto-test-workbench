import path from "node:path";
import fs from "fs-extra";

const root = process.cwd();
for (const dir of ["artifacts", "reports/html", "reports/junit", "reports/ai-summary"]) {
  await fs.emptyDir(path.join(root, dir));
}
console.log("Artifacts and generated reports cleaned.");
