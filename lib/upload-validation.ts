import path from "node:path";
import multer from "multer";

// Leave room for multipart headers below Vercel's 4.5 MB request-body cap.
export const MAX_FILE_SIZE = 4 * 1024 * 1024;
export const ACCEPTED_FILES = ".pdf,.png,.jpg,.jpeg,.txt";
const types: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
};

function expectedType(filename: string): string {
  if (Buffer.byteLength(filename) > 255 || /[\\/\x00-\x1f\x7f]/.test(filename)) {
    throw new Error("Invalid filename (maximum 255 bytes; no paths or control characters)");
  }
  const type = types[path.extname(filename).toLowerCase()];
  if (!type) throw new Error("Allowed file types: PDF, PNG, JPEG, and TXT");
  return type;
}

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 0, parts: 1 },
  fileFilter: (_req, file, cb) => {
    try {
      const expected = expectedType(file.originalname);
      if (file.mimetype !== expected && file.mimetype !== "application/octet-stream") {
        throw new Error("File extension and declared type do not match");
      }
      cb(null, true);
    } catch (error) {
      cb(error as Error);
    }
  },
});

// Check actual bytes after Multer parsing, before any storage/database write.
// Signatures identify formats; they are not a malware scan.
export function validateFile(file: Pick<Express.Multer.File, "originalname" | "buffer">): string {
  const type = expectedType(file.originalname);
  const bytes = file.buffer;
  if (!bytes.length) throw new Error("Empty files are not allowed");
  if (bytes.length > MAX_FILE_SIZE) throw new Error("File exceeds the 4 MB limit");
  let valid = false;
  switch (type) {
    case "application/pdf":
      valid = bytes.subarray(0, 5).equals(Buffer.from("%PDF-"));
      break;
    case "image/png":
      valid = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      break;
    case "image/jpeg":
      valid = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      break;
    case "text/plain":
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        valid = !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
      } catch {
        valid = false;
      }
      break;
  }
  if (!valid) throw new Error("File contents do not match the selected file type");
  return type;
}
