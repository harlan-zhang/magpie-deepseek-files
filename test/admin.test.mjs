import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { startAdminService } from "../lib/admin-server.mjs"

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII="
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64")

async function startFilesServer() {
  let uploads = 0
  let deletes = 0
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/files") {
      uploads++
      request.resume()
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: `file-api-admin-${uploads}` }))
      return
    }
    if (request.method === "DELETE" && request.url?.startsWith("/files/")) {
      deletes++
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ deleted: true }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    counts: () => ({ uploads, deletes }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function makeAdmin() {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-admin-"))
  const authPath = join(dir, "plugin-auth.json")
  await writeFile(authPath, JSON.stringify({
    "deepseek-files": { type: "api", key: "sk-admin-test" },
  }))
  const files = await startFilesServer()
  const service = startAdminService({
    port: 0,
    dataDir: dir,
    cachePath: join(dir, "cache.json"),
    imagesDir: join(dir, "images"),
    authPath,
    statusPath: join(dir, "status.json"),
    filesUrl: `${files.url}/files`,
    logger: { info() {}, warn() {}, error() {} },
  })
  const info = await service.ready
  return {
    dir,
    files,
    service,
    base: `http://127.0.0.1:${info.port}`,
    token: service.token,
    async close() {
      await service.close()
      await files.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("admin page lists, uploads, previews and deletes images", async () => {
  const admin = await makeAdmin()
  try {
    const page = await fetch(`${admin.base}/`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.equal(html.includes("__DEEPSEEK_FILES_TOKEN__"), false)
    assert.equal(html.includes(admin.token), true)
    assert.equal(html.includes("<style>"), true)
    assert.equal(html.includes("const token = document.body.dataset.token"), true)

    const unauthorized = await fetch(`${admin.base}/api/status`, { headers: { origin: "null" } })
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), "null")
    assert.equal((await unauthorized.json()).reload, true)

    const preflight = await fetch(`${admin.base}/api/status`, {
      method: "OPTIONS",
      headers: { origin: "null" },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get("access-control-allow-origin"), "null")

    const headers = { "x-deepseek-files-token": admin.token }
    const upload = await fetch(`${admin.base}/api/upload`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "image/png",
        "x-file-name": encodeURIComponent("test.png"),
      },
      body: PNG_BYTES,
    })
    const uploaded = await upload.json()
    assert.equal(upload.status, 200)
    assert.equal(uploaded.ok, true)
    assert.equal(admin.files.counts().uploads, 1)

    const list = await fetch(`${admin.base}/api/images`, { headers })
    const listed = await list.json()
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].hasLocal, true)

    const preview = await fetch(`${admin.base}${listed.items[0].previewUrl}`)
    assert.equal(preview.status, 200)
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG_BYTES)

    const removed = await fetch(`${admin.base}/api/images/${uploaded.item.hash}`, {
      method: "DELETE",
      headers,
    })
    assert.equal(removed.status, 200)
    assert.equal(admin.files.counts().deletes, 1)
    const after = await (await fetch(`${admin.base}/api/images`, { headers })).json()
    assert.equal(after.items.length, 0)
    const imagePath = join(admin.dir, "images", uploaded.item.hash)
    await assert.rejects(readFile(imagePath), (error) => error.code === "ENOENT")
  } finally {
    await admin.close()
  }
})
