import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { accountHashForKey, ImageUploader } from "../lib/upload.mjs"
import { FileIdCache } from "../lib/cache.mjs"

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII="
const IMAGE = { hash: "a".repeat(64), bytes: Buffer.from(PNG_BASE64, "base64"), mime: "image/png" }

function silentLogger(messages = []) {
  return {
    messages,
    warn(message) { messages.push(message) },
    info(message) { messages.push(message) },
  }
}

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

async function testCache(dir, apiKey = "sk-test") {
  return new FileIdCache({
    filePath: join(dir, "cache.json"),
    accountHash: accountHashForKey(apiKey),
    logger: silentLogger(),
  })
}

test("uploads multipart fields once and then uses the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-upload-"))
  let requests = 0
  let body = ""
  let authorization = ""
  const server = await startServer(async (request, response) => {
    requests++
    authorization = request.headers.authorization
    body = await readBody(request)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ id: "file-api-123", object: "file" }))
  })
  const cache = await testCache(dir)
  const uploader = new ImageUploader({
    apiKey: "sk-test",
    cache,
    filesUrl: `${server.url}/files`,
    retryDelayMs: 1,
    logger: silentLogger(),
  })

  assert.equal((await uploader.resolve(IMAGE)).fileId, "file-api-123")
  assert.equal((await uploader.resolve(IMAGE)).cacheHit, true)
  assert.equal(requests, 1)
  assert.equal(authorization, "Bearer sk-test")
  assert.match(body, /name="purpose"\r\n\r\nuser_data/)
  assert.match(body, /name="expires_after\[anchor\]"\r\n\r\ncreated_at/)
  assert.match(body, /name="expires_after\[seconds\]"\r\n\r\n2592000/)
  assert.match(body, /filename="aaaaaaaaaaaaaaaa\.png"/)
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

test("different API keys do not share cached file ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-upload-"))
  let requests = 0
  const server = await startServer(async (_request, response) => {
    requests++
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ id: `file-api-${requests}` }))
  })
  const first = new ImageUploader({
    apiKey: "sk-one",
    cache: await testCache(dir, "sk-one"),
    filesUrl: `${server.url}/files`,
    logger: silentLogger(),
  })
  const second = new ImageUploader({
    apiKey: "sk-two",
    cache: await testCache(dir, "sk-two"),
    filesUrl: `${server.url}/files`,
    logger: silentLogger(),
  })
  assert.equal((await first.resolve(IMAGE)).fileId, "file-api-1")
  assert.equal((await second.resolve(IMAGE)).fileId, "file-api-2")
  assert.equal(requests, 2)
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

test("expired cache entries are uploaded again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-upload-"))
  let requests = 0
  let now = 1_000
  const server = await startServer(async (_request, response) => {
    requests++
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ id: `file-api-${requests}` }))
  })
  const cache = await testCache(dir)
  const first = new ImageUploader({
    apiKey: "sk-test",
    cache,
    filesUrl: `${server.url}/files`,
    ttlSeconds: 3600,
    now: () => now,
    logger: silentLogger(),
  })
  assert.equal((await first.resolve(IMAGE)).fileId, "file-api-1")

  now += 3_600_001
  const second = new ImageUploader({
    apiKey: "sk-test",
    cache,
    filesUrl: `${server.url}/files`,
    ttlSeconds: 3600,
    now: () => now,
    logger: silentLogger(),
  })
  assert.equal((await second.resolve(IMAGE)).fileId, "file-api-2")
  assert.equal(requests, 2)
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

test("retries a 429 once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-upload-"))
  let requests = 0
  const server = await startServer(async (_request, response) => {
    requests++
    if (requests === 1) {
      response.statusCode = 429
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: { message: "slow down" } }))
      return
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ id: "file-api-retry" }))
  })
  const uploader = new ImageUploader({
    apiKey: "sk-test",
    cache: await testCache(dir),
    filesUrl: `${server.url}/files`,
    retryDelayMs: 1,
    logger: silentLogger(),
  })
  assert.equal((await uploader.resolve(IMAGE)).fileId, "file-api-retry")
  assert.equal(requests, 2)
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

test("401 marks the sign-in expired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-upload-"))
  const server = await startServer((_request, response) => {
    response.statusCode = 401
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ error: { message: "bad key" } }))
  })
  const uploader = new ImageUploader({
    apiKey: "sk-test",
    cache: await testCache(dir),
    filesUrl: `${server.url}/files`,
    logger: silentLogger(),
  })
  await assert.rejects(uploader.resolve(IMAGE), (error) => error.signIn === "expired")
  await server.close()
  await rm(dir, { recursive: true, force: true })
})

test("upload timeout fails without logging the key or image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-upload-"))
  const messages = []
  const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
    const abort = () => reject(init.signal.reason || new Error("aborted"))
    if (init.signal?.aborted) abort()
    else init.signal?.addEventListener("abort", abort, { once: true })
  })
  const uploader = new ImageUploader({
    apiKey: "sk-secret",
    cache: await testCache(dir, "sk-secret"),
    fetchImpl: hangingFetch,
    uploadTimeoutMs: 20,
    maxRetries: 0,
    logger: silentLogger(messages),
  })
  await assert.rejects(uploader.resolve(IMAGE), /aborted|timed out|abort/i)
  assert.equal(messages.join("\n").includes("sk-secret"), false)
  assert.equal(messages.join("\n").includes(PNG_BASE64), false)
  await rm(dir, { recursive: true, force: true })
})
