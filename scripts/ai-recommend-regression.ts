import { Command } from "commander";

const program = new Command();
program.option("--change-set <path>", "diff or changed files list");
program.parse();

console.log("Regression recommendation MVP rule:");
console.log("- API changes: run api + contract + dependent web smoke");
console.log("- Web page changes: run related web smoke and visual checks");
console.log("- App screen changes: run app smoke on smoke-fast device profile");
console.log(`Change set: ${program.opts().changeSet ?? "(not provided)"}`);
