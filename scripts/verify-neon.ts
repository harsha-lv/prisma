// Integration check against a running server and its configured Neon branch.
// Removes only the folders/uploads created by this check.
import "dotenv/config";
import assert from "node:assert/strict";
import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";
import { prisma, warmupDb } from "../lib/prisma";

const base = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const storage = new Files({ adapter: neon({ bucket: "uploads" }) });
const marker = `verify-${Date.now()}`;
const body = Buffer.from(`Neon upload verification: ${marker}\n`);
const createdUploads: { id: number; storedName: string }[] = [];
let folderId: number | undefined;

async function login(email: string) {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    body: new URLSearchParams({ email }),
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  assert.ok(cookie, "Login must establish a session");
  return cookie;
}

async function main() {
  await warmupDb();
  const cookie = await login("test@prisma.io");
  const otherCookie = await login("intruder@prisma.io");
  const user = await prisma.user.findUniqueOrThrow({ where: { email: "test@prisma.io" } });
  const request = (url: string, init: RequestInit = {}) =>
    fetch(`${base}${url}`, { ...init, headers: { Cookie: cookie, ...init.headers }, redirect: "manual" });
  try {
    const create = await request("/folders", {
      method: "POST", body: new URLSearchParams({ name: marker }),
    });
    assert.equal(create.status, 302);
    const folder = await prisma.folder.findUniqueOrThrow({
      where: { userId_name: { userId: user.id, name: marker } },
    });
    folderId = folder.id;

    for (const targetFolder of [null, folder.id]) {
      const filename = `${marker}-${targetFolder ?? "root"}.txt`;
      const data = new FormData();
      data.append("file", new Blob([body], { type: "text/plain" }), filename);
      const result = await request(targetFolder ? `/folders/${targetFolder}/upload` : "/upload", {
        method: "POST", body: data,
      });
      assert.equal(result.status, 302);
      assert.match(result.headers.get("location") ?? "", /uploaded=1/);
      const row = await prisma.upload.findFirstOrThrow({ where: { filename, userId: user.id } });
      createdUploads.push(row);
      assert.equal(row.folderId, targetFolder);
      assert.equal(row.size, body.length);
      assert.equal(row.mimeType, "text/plain");
      const stored = await storage.download(row.storedName);
      assert.deepEqual(Buffer.from(await stored.arrayBuffer()), body);
      const listing = await request(targetFolder ? `/folders/${targetFolder}` : "/");
      assert.match(await listing.text(), new RegExp(`/files/${row.id}`));
      const details = await request(`/files/${row.id}`);
      assert.equal(details.status, 200);
      assert.match(await details.text(), /File details[\s\S]*Uploaded[\s\S]*Download/);
      const download = await request(`/files/${row.id}/download`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
      for (const suffix of ["", "/download"]) {
        const denied = await fetch(`${base}/files/${row.id}${suffix}`, {
          headers: { Cookie: otherCookie }, redirect: "manual",
        });
        assert.equal(denied.status, 404);
        const anonymous = await fetch(`${base}/files/${row.id}${suffix}`, { redirect: "manual" });
        assert.equal(anonymous.headers.get("location"), "/login");
      }
      console.log(`${targetFolder ? "Folder" : "Root"}: upload → Neon metadata → bucket bytes → details → matching download; ownership OK`);
    }

    const before = await prisma.upload.count();
    for (const [filename, buffer, type] of [
      ["fake.png", Buffer.from("not PNG"), "image/png"],
      ["too-large.txt", Buffer.alloc(4 * 1024 * 1024 + 1, 65), "text/plain"],
    ] as const) {
      const data = new FormData();
      data.append("file", new Blob([buffer], { type }), filename);
      const result = await request("/upload", { method: "POST", body: data });
      assert.equal(result.status, 302);
      assert.match(result.headers.get("location") ?? "", /error=/);
    }
    assert.equal(await prisma.upload.count(), before);
    console.log("Invalid content and >4 MB uploads: rejected, no metadata created");
    // This existing legacy record has no source bytes; preserve it, return 404.
    const legacy = await prisma.upload.findFirst({ where: { userId: user.id, storedName: { not: { startsWith: "uploads/" } } } });
    if (legacy) {
      const missing = await request(`/files/${legacy.id}/download`);
      assert.equal(missing.status, 404);
      console.log("Missing legacy object: download returns 404");
    }
  } finally {
    for (const row of createdUploads) {
      await prisma.upload.delete({ where: { id: row.id } });
      await storage.delete(row.storedName);
    }
    if (folderId) await prisma.folder.delete({ where: { id: folderId } });
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("Neon integration verification failed");
  process.exitCode = 1;
  void prisma.$disconnect();
});
