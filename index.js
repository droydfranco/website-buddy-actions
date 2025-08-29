
import express from "express";
import { Octokit } from "@octokit/rest";
import ftp from "basic-ftp";
import multer from "multer";
import AdmZip from "adm-zip";

const app = express();
app.use(express.json({ limit: "50mb" }));

// File upload
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ---- Simple auth (require secret header)
function requireKey(req, res, next) {
  const key = req.header("x-actions-key");
  if (!key || key !== process.env.ACTIONS_AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true, message: "Website Buddy Actions running" }));

// ---- GitHub: list repos
app.get("/github/list-repos", requireKey, async (req, res) => {
  try {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const { data } = await octokit.repos.listForAuthenticatedUser({ per_page: 100 });
    res.json(data.map(r => ({
      owner: r.owner?.login,
      name: r.name,
      private: r.private,
      default_branch: r.default_branch,
      url: r.html_url
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- GitHub: get a file (raw)
app.post("/github/get-file", requireKey, async (req, res) => {
  try {
    const { owner, repo, path, ref } = req.body; // ref = branch (optional)
    if (!owner || !repo || !path) return res.status(400).json({ error: "owner, repo, and path are required" });
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (!("content" in data)) return res.status(400).json({ error: "Not a file" });
    const buffer = Buffer.from(data.content, "base64");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(buffer.toString("utf-8"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- GitHub: create/update a file
app.post("/github/put-file", requireKey, async (req, res) => {
  try {
    const { owner, repo, path, content, message, branch } = req.body;
    if (!owner || !repo || !path || !content || !message) {
      return res.status(400).json({ error: "owner, repo, path, content, message are required" });
    }
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    // Check if file exists to get its SHA
    let sha = undefined;
    try {
      const get = await octokit.repos.getContent({ owner, repo, path, ref: branch });
      if ("sha" in get.data) sha = get.data.sha;
      if ("sha" in get.data && Array.isArray(get.data)) sha = undefined; // shouldn't happen
    } catch (e) {
      // 404 = new file
    }
    const b64 = Buffer.from(content, "utf-8").toString("base64");
    const result = await octokit.repos.createOrUpdateFileContents({
      owner, repo, path, message, content: b64, sha, branch
    });
    res.json({ ok: true, path, branch: branch || result.data.content?.path, committed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- FTP helper
async function uploadBuffer(client, remotePath, buffer) {
  const parts = remotePath.split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  if (dirs.length) {
    await client.ensureDir("/" + dirs.join("/"));
  }
  await client.uploadFrom(Buffer.from(buffer), remotePath);
}

// ---- Deploy: upload a single file (multipart/form-data field: file)
app.post("/deploy/upload-ftp", requireKey, upload.single("file"), async (req, res) => {
  const client = new ftp.Client();
  try {
    if (!req.file) return res.status(400).json({ error: "No file. Use field name 'file'." });
    const { remotePath = "/htdocs/index.html" } = req.body;

    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: false
    });

    await uploadBuffer(client, remotePath, req.file.buffer);
    res.json({ ok: true, uploaded: remotePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.close();
  }
});

// ---- Deploy: upload a ZIP (extract and upload all files)
app.post("/deploy/upload-zip", requireKey, upload.single("zip"), async (req, res) => {
  const client = new ftp.Client();
  try {
    if (!req.file) return res.status(400).json({ error: "No zip uploaded. Use field name 'zip'." });
    const { basePath = "/htdocs" } = req.body;

    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: false
    });

    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    for (const e of entries) {
      if (e.isDirectory) continue;
      const remote = basePath + "/" + e.entryName.replace(/^\/+/, "");
      await uploadBuffer(client, remote, e.getData());
    }

    res.json({ ok: true, uploaded: entries.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.close();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Website Buddy Actions listening on ${port}`));
