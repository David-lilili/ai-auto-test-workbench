import path from "node:path";
import { diagnoseFailurePackage, writeFailureDiagnosisArtifacts, writeFailureDiagnosisSidecar } from "../src/core/failure-diagnosis.js";

interface CliOptions {
  input?: string;
  out?: string;
  md?: string;
  intentCount?: number;
  writeSidecar?: boolean;
}

const options = parseArgs(process.argv.slice(2));
if (!options.input) {
  console.error("Usage: npx tsx scripts/diagnose-failure-package.ts <failure-package.json> --out <proposal.json> [--md <report.md>] [--intent-count 1]");
  process.exit(2);
}

const diagnosis = await diagnoseFailurePackage(options.input, {
  intentData: options.intentCount === undefined ? undefined : { count: options.intentCount },
  intentSourceId: options.intentCount === undefined ? undefined : "cli_intent_data"
});

if (options.out) {
  await writeFailureDiagnosisArtifacts({
    diagnosis,
    jsonOut: options.out,
    markdownOut: options.md
  });
  console.log(`proposal=${path.normalize(options.out)}`);
  if (options.md) console.log(`report=${path.normalize(options.md)}`);
} else {
  console.log(JSON.stringify(diagnosis, null, 2));
}

if (options.writeSidecar) {
  const sidecarPath = await writeFailureDiagnosisSidecar({
    failurePackagePath: options.input,
    diagnosis
  });
  console.log(`sidecar=${path.normalize(sidecarPath)}`);
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out") {
      result.out = args[++index];
      continue;
    }
    if (arg === "--md" || arg === "--markdown") {
      result.md = args[++index];
      continue;
    }
    if (arg === "--intent-count") {
      result.intentCount = Number(args[++index]);
      continue;
    }
    if (arg === "--write-sidecar") {
      result.writeSidecar = true;
      continue;
    }
    if (!arg.startsWith("--") && !result.input) result.input = arg;
  }
  return result;
}
