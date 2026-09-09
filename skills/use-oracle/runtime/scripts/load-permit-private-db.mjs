import {
  createPostgresTylerPrivateStore,
  loadTylerPrivateDatabase,
  resolvePrivateDatabaseUrl,
  verifyTylerPrivateLoad,
} from "../src/permits/private-db-load.mjs";
import { readPermitPrivateLoadBundle } from "../src/permits/private-load.mjs";

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag ?? "argument"}`);
    }
    if (
      ![
        "--input",
        "--database-url-env",
        "--county",
        "--source-system",
        "--parcel",
        "--permits",
      ].includes(flag)
    ) {
      throw new Error(`Unknown option ${flag}`);
    }
    options.set(flag, value);
  }
  const required = [
    "--input",
    "--database-url-env",
    "--county",
    "--source-system",
    "--parcel",
    "--permits",
  ];
  if (required.some((flag) => !options.get(flag))) {
    throw new Error(
      "Usage: load-permit-private-db.mjs --input <directory> --database-url-env <name> --county <key> --source-system <key> --parcel <identifier> --permits <comma-separated exact permit numbers>",
    );
  }
  const permitNumbers = options
    .get("--permits")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (permitNumbers.length === 0) {
    throw new Error("--permits must name at least one permit");
  }
  return {
    inputDir: options.get("--input"),
    databaseUrlEnvironment: options.get("--database-url-env"),
    expectedScope: {
      countyKey: options.get("--county"),
      sourceSystem: options.get("--source-system"),
      parcelIdentifier: options.get("--parcel"),
      permitNumbers,
    },
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = resolvePrivateDatabaseUrl({
    environmentName: options.databaseUrlEnvironment,
  });
  const bundle = await readPermitPrivateLoadBundle(options.inputDir);
  const imported = await import("pg");
  const Client = imported.default?.Client ?? imported.Client;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const store = createPostgresTylerPrivateStore(client);
    const loaded = await loadTylerPrivateDatabase({
      bundle,
      store,
      expectedScope: options.expectedScope,
    });
    const readBack = await verifyTylerPrivateLoad({ bundle, store });
    process.stdout.write(
      `${JSON.stringify({
        event: "permit_private_database_load_complete",
        countyKey: bundle.manifest.countyKey,
        loaded,
        readBack,
      })}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      event: "permit_private_database_load_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
