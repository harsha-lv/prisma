import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  buckets: {
    // Private bucket: every read/write requires this branch's S3 credential.
    // Object keys follow uploads/<userId>/<uuid><ext>; the key is stored in
    // the Upload.storedName column of the Postgres schema on the same branch.
    uploads: { access: "private" },
  },
});
