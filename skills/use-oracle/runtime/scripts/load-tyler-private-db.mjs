import {
  createPostgresTylerPrivateStore,
  loadTylerPrivateDatabase,
  resolvePrivateDatabaseUrl,
  verifyTylerPrivateLoad,
} from "../src/permits/private-db-load.mjs";
import { readTylerPrivateLoadBundle } from "../src/permits/private-load.mjs";

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag ?? "argument"}`);
    }
    if (!["--input", "--database-url-env"].includes(flag)) {
      throw new Error(`Unknown option ${flag}`);
    }
    options.set(flag, value);
  }
  const inputDir = options.get("--input");
  const databaseUrlEnvironment = options.get("--database-url-env");
  if (!inputDir || !databaseUrlEnvironment) {
    throw new Error(
      "Usage: load-tyler-private-db.mjs --input <directory> --database-url-env <name>",
    );
  }
  return { inputDir, databaseUrlEnvironment };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = resolvePrivateDatabaseUrl({
    environmentName: options.databaseUrlEnvironment,
  });
  const bundle = await readTylerPrivateLoadBundle(options.inputDir);
  const imported = await import("pg");
  const Client = imported.default?.Client ?? imported.Client;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const store = createPostgresTylerPrivateStore(client);
    const loaded = await loadTylerPrivateDatabase({ bundle, store });
    const readBack = await verifyTylerPrivateLoad({ bundle, store });
    process.stdout.write(
      `${JSON.stringify({
        event: "tyler_private_database_load_complete",
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
      event: "tyler_private_database_load_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
