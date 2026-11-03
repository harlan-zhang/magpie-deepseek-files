import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import plugin from "../index.mjs"

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII="
const PNG_BASE64 = PNG.split(",")[1]

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

function readJson(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
  })
}

function readText(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

test("plugin declares the DeepSeek Files provider and model", async () => {
  const hooks = await plugin.server({}, { adminService: false })
  const config = {}
  await hooks.config(config)
  const provider = config.provider["deepseek-files"]
  assert.equal(provider.npm, "@ai-sdk/openai")
  assert.equal(provider.api, "https://api.deepseek.com/v1")
  assert.equal(provider.models["deepseek-flash"].limit.context, 1_048_576)
  assert.equal(provider.models["deepseek-flash"].limit.output, 393_216)
  assert.deepEqual(provider.models["deepseek-flash"].modalities.input, ["text", "image"])
})

test("plugin rewrites Responses images through the Files API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-plugin-"))
  let responseBody
  let files = 0
  const server = await startServer(async (request, response) => {
    if (request.url === "/files") {
      files++
      await readText(request)
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "file-api-plugin" }))
      return
    }
    if (request.url === "/v1/responses") {
      responseBody = await readJson(request)
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "resp-test" }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  const info = []
  const options = {
    baseUrl: `${server.url}/v1`,
    filesUrl: `${server.url}/files`,
    cachePath: join(dir, "cache.json"),
    logger: { info: (message) => info.push(message), warn: (message) => info.push(message) },
  }
  const hooks = await plugin.server({}, { ...options, adminService: false })
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "sk-plugin" }))
  const body = {
    model: "deepseek-flash",
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: PNG },
    ] }],
  }
  const response = await loader.fetch(`${server.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  try {
    assert.equal(response.status, 200)
    assert.equal(files, 1)
    assert.equal(responseBody.input[0].content[1].file_id, "file-api-plugin")
    assert.equal("image_url" in responseBody.input[0].content[1], false)
    assert.equal(info.join("\n").includes(PNG_BASE64), false)
    assert.match(info.join("\n"), /images=1 unique=1 uploaded=1 cacheHits=0/)

    const cache = JSON.parse(await readFile(join(dir, "cache.json"), "utf8"))
    assert.equal(JSON.stringify(cache).includes(PNG_BASE64), false)
    assert.equal(JSON.stringify(cache).includes("sk-plugin"), false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("plugin leaves a no-image Responses request byte-for-byte equivalent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-plugin-"))
  let body = ""
  const server = await startServer(async (request, response) => {
    body = await readText(request)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ id: "resp-test" }))
  })
  const hooks = await plugin.server({}, {
    adminService: false,
    baseUrl: `${server.url}/v1`,
    filesUrl: `${server.url}/files`,
    cachePath: join(dir, "cache.json"),
    logger: { info() {}, warn() {} },
  })
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "sk-plugin" }))
  const original = JSON.stringify({ model: "deepseek-flash", input: "hello" })
  try {
    await loader.fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: original,
    })
    assert.equal(body, original)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("plugin rejects a body that remains too large after externalization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-plugin-"))
  const server = await startServer(async (request, response) => {
    if (request.url === "/files") {
      await readText(request)
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: "file-api-plugin" }))
      return
    }
    await readText(request)
    response.end("{}")
  })
  const hooks = await plugin.server({}, {
    adminService: false,
    baseUrl: `${server.url}/v1`,
    filesUrl: `${server.url}/files`,
    cachePath: join(dir, "cache.json"),
    maxBodyBytes: 1024,
    logger: { info() {}, warn() {} },
  })
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "sk-plugin" }))
  const body = {
    model: "deepseek-flash",
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "x".repeat(4000) },
      { type: "input_image", image_url: PNG },
    ] }],
  }
  try {
    await assert.rejects(loader.fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), /after image externalization/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("plugin refreshes file ids rejected as missing and retries once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-plugin-"))
  let uploads = 0
  let responses = 0
  const server = await startServer(async (request, response) => {
    if (request.url === "/files") {
      uploads++
      await readText(request)
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ id: `file-api-${uploads}` }))
      return
    }
    responses++
    const parsed = await readJson(request)
    if (responses === 1) {
      response.statusCode = 400
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: { message: "file_id not found" } }))
      return
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      id: "resp-test",
      fileId: parsed.input[0].content[1].file_id,
    }))
  })
  const hooks = await plugin.server({}, {
    adminService: false,
    baseUrl: `${server.url}/v1`,
    filesUrl: `${server.url}/files`,
    cachePath: join(dir, "cache.json"),
    logger: { info() {}, warn() {} },
  })
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "sk-plugin" }))
  const body = {
    model: "deepseek-flash",
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: PNG },
    ] }],
  }
  try {
    const response = await loader.fetch(`${server.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(uploads, 2)
    assert.equal(responses, 2)
    assert.equal(payload.fileId, "file-api-2")
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
