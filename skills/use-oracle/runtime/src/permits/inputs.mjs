import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

export async function readPermitPropertyInputs(
  parquetPath,
  { offset = 0, limit = null } = {},
) {
  const reader = await ParquetReader.openFile(parquetPath);
  const rows = [];
  let index = 0;
  try {
    const cursor = reader.getCursor([
      "property_id",
      "parcel_identifier",
      "address_city",
    ]);
    let row = await cursor.next();
    while (row) {
      if (index >= offset && (limit === null || rows.length < limit)) {
        rows.push(row);
      }
      index += 1;
      if (limit !== null && rows.length >= limit) break;
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return rows;
}
