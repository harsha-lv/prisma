// One-off: copy all rows from the local Postgres database into Neon,
// preserving primary keys, then reset the id sequences.
import "dotenv/config";
import { Client } from "pg";
import { prisma, warmupDb } from "../lib/prisma";

const LOCAL_URL = process.env.LOCAL_DATABASE_URL;
if (!LOCAL_URL) throw new Error("LOCAL_DATABASE_URL is required");

async function main() {
  await warmupDb();
  const local = new Client({ connectionString: LOCAL_URL });
  await local.connect();

  const users = (await local.query('SELECT id, email, name FROM "User" ORDER BY id')).rows;
  const folders = (await local.query('SELECT id, name, "createdAt", "userId" FROM "Folder" ORDER BY id')).rows;
  const posts = (await local.query('SELECT id, title, content, published, "authorId" FROM "Post" ORDER BY id')).rows;
  const uploads = (await local.query('SELECT id, filename, "storedName", "mimeType", size, "uploadedAt", "userId", "folderId" FROM "Upload" ORDER BY id')).rows;
  await local.end();

  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, update: { email: u.email, name: u.name }, create: { id: u.id, email: u.email, name: u.name } });
  }
  for (const f of folders) {
    await prisma.folder.upsert({ where: { id: f.id }, update: { name: f.name, userId: f.userId }, create: { id: f.id, name: f.name, createdAt: f.createdAt, userId: f.userId } });
  }
  for (const p of posts) {
    await prisma.post.upsert({ where: { id: p.id }, update: {}, create: { id: p.id, title: p.title, content: p.content, published: p.published, authorId: p.authorId } });
  }
  for (const up of uploads) {
    await prisma.upload.upsert({
      where: { id: up.id },
      update: {},
      create: {
        id: up.id,
        filename: up.filename,
        storedName: up.storedName,
        mimeType: up.mimeType,
        size: up.size,
        uploadedAt: up.uploadedAt,
        userId: up.userId,
        folderId: up.folderId,
      },
    });
  }

  // Keep autoincrement counters ahead of the copied ids
  await prisma.$executeRawUnsafe(`SELECT setval('"User_id_seq"', COALESCE((SELECT MAX(id) FROM "User"), 1))`);
  await prisma.$executeRawUnsafe(`SELECT setval('"Folder_id_seq"', COALESCE((SELECT MAX(id) FROM "Folder"), 1))`);
  await prisma.$executeRawUnsafe(`SELECT setval('"Post_id_seq"', COALESCE((SELECT MAX(id) FROM "Post"), 1))`);
  await prisma.$executeRawUnsafe(`SELECT setval('"Upload_id_seq"', COALESCE((SELECT MAX(id) FROM "Upload"), 1))`);

  const counts = {
    users: await prisma.user.count(),
    folders: await prisma.folder.count(),
    posts: await prisma.post.count(),
    uploads: await prisma.upload.count(),
  };
  console.log("Neon now holds:", JSON.stringify(counts));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
