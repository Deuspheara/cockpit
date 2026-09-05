/** Explicit CLI: synthetic checks never execute finance tools or print provider payloads. */
import { readConfig } from "../../config.js";
import { OpenRouterClient } from "./openrouter.js";
import { runSmokeChecks } from "./smoke-checks.js";
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--diagnose")) {
  console.error("Usage: node dist/modules/agent/smoke.js [--diagnose]");
  process.exitCode = 2;
} else {
  process.exitCode = (await runSmokeChecks(
    new OpenRouterClient(readConfig()),
    args.includes("--diagnose"),
  ))
    ? 0
    : 1;
}
