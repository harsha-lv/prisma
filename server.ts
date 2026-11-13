import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import multer from "multer";
import { prisma } from "./lib/prisma";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Ensure the upload directory exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Multer configuration
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  // Prefix the stored name with random bytes so user files never collide
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    // Accept everything except executables/scripts as a sensible default
    const blocked = [".exe", ".bat", ".cmd", ".sh", ".js", ".mjs", ".php"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blocked.includes(ext)) {
      return cb(new Error(`File type ${ext} is not allowed`));
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Session-based authentication (demo-grade: log in by email, no password)
// ---------------------------------------------------------------------------
declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      user?: { id: number; email: string; name: string | null };
      folder?: { id: number; name: string };
    }
  }
}

app.use(
  session({
    secret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Attach the logged-in user (if any) to res.locals for every request
app.use(async (req, res, next) => {
  if (req.session.userId) {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: { id: true, email: true, name: true },
    });
    if (user) res.locals.user = user;
    else req.session.destroy(() => {});
  }
  next();
});

// Gate every page route behind a valid session
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!res.locals.user) return res.status(401).redirect("/login");
  next();
}

// Load :id from the route, verify the folder belongs to the signed-in user
async function requireFolder(req: Request, res: Response, next: NextFunction) {
  const folderId = Number(req.params.id);
  if (!Number.isInteger(folderId)) return res.status(404).send("Not found");

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, userId: res.locals.user!.id },
  });
  if (!folder) return res.status(404).send("Not found");

  res.locals.folder = folder;
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const renderUploads = (uploads: { id: number; filename: string; size: number; mimeType: string }[]) =>
  uploads.length === 0
    ? "<p>No files here yet.</p>"
    : `<ul>${uploads
        .map(
          (u) =>
            `<li>${escapeHtml(u.filename)} <small>(${(u.size / 1024).toFixed(1)} KB, ${escapeHtml(u.mimeType)})</small></li>`,
        )
        .join("")}</ul>`;

const uploadForm = (action: string) => `
<form method="post" action="${action}" enctype="multipart/form-data">
  <input type="file" name="file" required />
  <button type="submit">Upload</button>
</form>`;

// Shared multer handler for both root and folder uploads
async function handleUpload(req: Request, res: Response, folderId: number | null, backUrl: string) {
  if (!req.file) return res.redirect(`${backUrl}?error=No%20file%20provided`);

  await prisma.upload.create({
    data: {
      filename: req.file.originalname,
      storedName: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
      userId: res.locals.user!.id,
      folderId,
    },
  });
  res.redirect(`${backUrl}?uploaded=1`);
}

function multerErrorRedirect(err: unknown, req: Request, res: Response, backUrl: string) {
  const message =
    err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
      ? "File exceeds the 5 MB limit"
      : (err as Error).message;
  // Multer may have written a partial file before the error — clean it up
  if (req.file?.path) fs.rm(req.file.path, () => {});
  return res.redirect(`${backUrl}?error=${encodeURIComponent(message)}`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const layout = (title: string, body: string) => `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 3rem auto; padding: 0 1rem; color: #222; }
    form { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; }
    form.inline { display: inline-block; border: none; padding: 0; margin: 0; }
    input[type="file"] { margin: 1rem 0; display: block; }
    button { padding: .5rem 1.2rem; cursor: pointer; }
    .user-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
    .error { color: #b00; }
    .success { color: #080; }
    ul { padding-left: 1.2rem; }
    .flash { margin: 0; }
  </style>
</head>
<body>${body}</body>
</html>`;

const flash = (req: Request, uploadedMessage: string) => `
${req.query.error ? `<p class="error flash">${escapeHtml(String(req.query.error))}</p>` : ""}
${req.query.uploaded ? `<p class="success flash">${escapeHtml(uploadedMessage)}</p>` : ""}`;

const userBar = (user: { email: string }) => `
<div class="user-bar">
  <span>Signed in as <strong>${escapeHtml(user.email)}</strong></span>
  <form method="post" action="/logout"><button type="submit">Log out</button></form>
</div>`;

app.get("/login", (req, res) => {
  if (res.locals.user) return res.redirect("/");
  res.send(
    layout("Login", `
    <h1>Sign in</h1>
    ${req.query.error ? `<p class="error">Email is required.</p>` : ""}
    <form method="post" action="/login">
      <label>Email <input type="email" name="email" required autofocus /></label>
      <button type="submit">Sign in</button>
    </form>`),
  );
});

app.post("/login", async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email) return res.redirect("/login?error=1");

  // Demo-grade auth: find-or-create the user by email (no password check).
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email },
  });
  req.session.userId = user.id;
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Home: folders, root files, create-folder and root upload forms
app.get("/", requireAuth, async (req, res) => {
  const user = res.locals.user!;
  const [folders, uploads] = await Promise.all([
    prisma.folder.findMany({
      where: { userId: user.id },
      orderBy: { name: "asc" },
      include: { _count: { select: { uploads: true } } },
    }),
    prisma.upload.findMany({
      where: { userId: user.id, folderId: null },
      orderBy: { uploadedAt: "desc" },
    }),
  ]);

  res.send(
    layout("Your files", `
    ${userBar(user)}
    ${flash(req, "File uploaded successfully.")}
    <h1>Files</h1>
    ${uploadForm("/upload")}
    <h2>Folders</h2>
    <form method="post" action="/folders">
      <label>New folder name <input type="text" name="name" required maxlength="64" /></label>
      <button type="submit">Create folder</button>
    </form>
    ${folders.length === 0 ? "<p>No folders yet.</p>" : `
    <ul>
      ${folders
        .map(
          (f) =>
            `<li><a href="/folders/${f.id}">${escapeHtml(f.name)}</a> <small>(${f._count.uploads} file${f._count.uploads === 1 ? "" : "s"})</small></li>`,
        )
        .join("")}
    </ul>`}
    <h2>Root files</h2>
    ${renderUploads(uploads)}`),
  );
});

// --- Folder CRUD ------------------------------------------------------------
// Create
app.post("/folders", requireAuth, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 64) : "";
  if (!name) return res.redirect("/?error=Folder%20name%20is%20required");

  try {
    await prisma.folder.create({
      data: { name, userId: res.locals.user!.id },
    });
    res.redirect("/");
  } catch (err: unknown) {
    // P2002 = unique constraint violation (folder name already exists for this user)
    if ((err as { code?: string }).code === "P2002") {
      return res.redirect(`/?error=${encodeURIComponent(`Folder "${name}" already exists`)}`);
    }
    throw err;
  }
});

// Read (single folder with its files)
app.get("/folders/:id", requireAuth, requireFolder, async (req, res) => {
  const folder = res.locals.folder!;
  const uploads = await prisma.upload.findMany({
    where: { folderId: folder.id },
    orderBy: { uploadedAt: "desc" },
  });

  res.send(
    layout(escapeHtml(folder.name), `
    ${userBar(res.locals.user!)}
    <p><a href="/">&larr; All files</a></p>
    <h1>Folder: ${escapeHtml(folder.name)}</h1>
    ${flash(req, "File uploaded successfully.")}
    ${uploadForm(`/folders/${folder.id}/upload`)}
    <h2>Rename folder</h2>
    <form method="post" action="/folders/${folder.id}/rename">
      <label>New name <input type="text" name="name" required maxlength="64" value="${escapeHtml(folder.name)}" /></label>
      <button type="submit">Rename</button>
    </form>
    <h2>Delete folder</h2>
    <p>Deleting moves its files back to root.</p>
    <form method="post" action="/folders/${folder.id}/delete" onsubmit="return confirm('Delete this folder?')">
      <button type="submit">Delete folder</button>
    </form>
    <h2>Files in this folder</h2>
    ${renderUploads(uploads)}`),
  );
});

// Update (rename)
app.post("/folders/:id/rename", requireAuth, requireFolder, async (req, res) => {
  const folder = res.locals.folder!;
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 64) : "";
  if (!name) return res.redirect(`/folders/${folder.id}?error=Folder%20name%20is%20required`);

  try {
    await prisma.folder.update({
      where: { id: folder.id },
      data: { name },
    });
    res.redirect(`/folders/${folder.id}`);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      return res.redirect(
        `/folders/${folder.id}?error=${encodeURIComponent(`Folder "${name}" already exists`)}`,
      );
    }
    throw err;
  }
});

// Delete — uploads fall back to root via onDelete: SetNull
app.post("/folders/:id/delete", requireAuth, requireFolder, async (_req, res) => {
  const folder = res.locals.folder!;
  await prisma.folder.delete({ where: { id: folder.id } });
  res.redirect("/");
});

// --- Uploads ----------------------------------------------------------------
// Root upload
app.post("/upload", requireAuth, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return multerErrorRedirect(err, req, res, "/");
    void handleUpload(req, res, null, "/");
  });
});

// Upload into a folder
app.post("/folders/:id/upload", requireAuth, requireFolder, (req, res) => {
  upload.single("file")(req, res, (err) => {
    const backUrl = `/folders/${res.locals.folder!.id}`;
    if (err) return multerErrorRedirect(err, req, res, backUrl);
    void handleUpload(req, res, res.locals.folder!.id, backUrl);
  });
});

// 404 catch-all
app.use((_req, res) => res.status(404).send("Not found"));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
