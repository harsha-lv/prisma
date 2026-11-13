import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { upload, validateFile, MAX_FILE_SIZE } from "../lib/upload-validation";

test("validates contents and canonical MIME types", () => {
  const cases = [
    ["hello.txt", Buffer.from("Hello 🌍\n"), "text/plain"],
    ["document.PDF", Buffer.from("%PDF-1.7\n"), "application/pdf"],
    ["image.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"],
    ["photo.jpeg", Buffer.from([255, 216, 255, 224]), "image/jpeg"],
  ] as const;
  for (const [originalname, buffer, expected] of cases) {
    assert.equal(validateFile({ originalname, buffer }), expected);
  }
});

test("rejects empty, oversized, disguised, binary, and unsafe files", () => {
  const cases = [
    ["empty.txt", Buffer.alloc(0)],
    ["big.txt", Buffer.alloc(MAX_FILE_SIZE + 1, 65)],
    ["fake.png", Buffer.from("not an image")],
    ["fake.pdf", Buffer.from("not PDF")],
    ["fake.jpg", Buffer.from("not JPEG")],
    ["binary.txt", Buffer.from([0, 1, 2])],
    ["invalid-utf8.txt", Buffer.from([255, 254])],
    ["script.exe", Buffer.from("MZ")],
    ["../escape.txt", Buffer.from("hello")],
    ["bad\nname.txt", Buffer.from("hello")],
  ] as const;
  for (const [originalname, buffer] of cases) {
    assert.throws(() => validateFile({ originalname, buffer }), originalname);
  }
});

test("multipart pipeline enforces size, type, count, and content before persistence", async () => {
  const app = express();
  let persisted = 0;
  app.post("/upload", (req, res) => {
    upload.single("file")(req, res, (err) => {
      try {
        if (err) throw err;
        if (!req.file) throw new Error("No file provided");
        validateFile(req.file);
        persisted++;
        res.sendStatus(201);
      } catch {
        res.sendStatus(400);
      }
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const send = async (name: string, data: Uint8Array, type: string, extra = false) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type }), name);
    if (extra) form.append("file", new Blob(["extra"]), "extra.txt");
    return (await fetch(`http://127.0.0.1:${address.port}/upload`, { method: "POST", body: form })).status;
  };
  try {
    assert.equal(await send("ok.txt", Buffer.from("hello"), "text/plain"), 201);
    assert.equal(await send("fake.png", Buffer.from("hello"), "image/png"), 400);
    assert.equal(await send("bad.exe", Buffer.from("MZ"), "application/octet-stream"), 400);
    assert.equal(await send("wrong.txt", Buffer.from("hello"), "image/png"), 400);
    assert.equal(await send("empty.txt", Buffer.alloc(0), "text/plain"), 400);
    assert.equal(await send("big.txt", Buffer.alloc(MAX_FILE_SIZE + 1, 65), "text/plain"), 400);
    assert.equal(await send("two.txt", Buffer.from("hello"), "text/plain", true), 400);
    assert.equal(persisted, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
