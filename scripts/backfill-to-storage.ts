// One-off migration: move locally-stored uploads into the Neon Object Storage
// bucket and repoint each Upload row's storedName to its new bucket key.
import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";
import { prisma, warmupDb } from "../lib/prisma";

const files = new Files({ adapter: neon({ bucket: "uploads" }) });
const LEGACY_DIR = path.join(process.cwd(), "uploads");

async function main() {
  await warmupDb();
  const rows = await prisma.upload.findMany();
  for (const row of rows) {
    if (row.storedName.startsWith(`uploads/${row.userId}/`)) {
      console.log(`already migrated id=${row.id}`);
      continue;
    }
    const localPath = path.join(LEGACY_DIR, row.storedName);
    if (!fs.existsSync(localPath)) {
      console.log(`skip id=${row.id}: ${row.storedName} not found on disk`);
      continue;
    }

    const key = `uploads/${row.userId}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}${path.extname(row.filename)}`;
    await files.upload(key, fs.readFileSync(localPath), { contentType: row.mimeType });
    await prisma.upload.update({ where: { id: row.id }, data: { storedName: key } });
    console.log(`moved id=${row.id}: ${row.filename} -> ${key}`);
  }

  // Verify every row now resolves in the bucket
  const verify = await Promise.all(
    (await prisma.upload.findMany()).map(async (row) => ({
      id: row.id,
      ok: await files.exists(row.storedName),
    })),
  );
  console.log("verification:", verify);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
