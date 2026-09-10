import { prepareTylerPrivateLoad } from "../src/permits/private-load.mjs";

function parseOptions(argv) {
  const capturePaths = [];
  let outputDir = null;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag ?? "argument"}`);
    }
    if (flag === "--capture") {
      capturePaths.push(value);
    } else if (flag === "--output") {
      outputDir = value;
    } else {
      throw new Error(`Unknown option ${flag}`);
    }
  }
  if (capturePaths.length === 0 || !outputDir) {
    throw new Error(
      "Usage: prepare-tyler-private-load.mjs --capture <json> [--capture <json>] --output <directory>",
    );
  }
  return { capturePaths, outputDir };
}

const options = parseOptions(process.argv.slice(2));
const manifest = await prepareTylerPrivateLoad(options);
process.stdout.write(
  `${JSON.stringify({
    event: "tyler_private_load_prepared",
    outputDir: options.outputDir,
    permitCount: manifest.permitCount,
    contractorCount: manifest.contractorCount,
    artifacts: manifest.artifacts,
  })}\n`,
);
