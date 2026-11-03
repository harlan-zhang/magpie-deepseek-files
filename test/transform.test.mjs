import assert from "node:assert/strict"
import test from "node:test"
import { externalizeResponsesImages } from "../lib/transform.mjs"
import { sha256Hex } from "../lib/data-url.mjs"

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII="

function fakeUploader() {
  const calls = []
  return {
    calls,
    async resolve({ hash }) {
      calls.push(hash)
      return { fileId: `file-api-${hash.slice(0, 12)}`, cacheHit: false }
    },
  }
}

function silentLogger() {
  return { warn() {}, info() {} }
}

test("replaces data URL images in messages and tool output", async () => {
  const imageBytes = Buffer.from(PNG.split(",")[1], "base64")
  const imageHash = sha256Hex(imageBytes)
  const uploader = fakeUploader()
  const body = {
    model: "deepseek-flash",
    input: [
      { type: "message", role: "user", content: [
        { type: "input_text", text: "Inspect this" },
        { type: "input_image", image_url: PNG, detail: "original" },
      ] },
      { type: "function_call_output", call_id: "call_1", output: [
        { type: "input_image", image_url: PNG },
      ] },
    ],
  }

  const result = await externalizeResponsesImages(body, uploader, { logger: silentLogger() })
  const imageParts = [
    result.body.input[0].content[1],
    result.body.input[1].output[0],
  ]

  assert.equal(result.stats.images, 2)
  assert.equal(result.stats.unique, 1)
  assert.equal(uploader.calls.length, 1)
  assert.equal(uploader.calls[0], imageHash)
  for (const part of imageParts) {
    assert.equal(part.file_id, `file-api-${imageHash.slice(0, 12)}`)
    assert.equal("image_url" in part, false)
  }
  assert.equal(imageParts[0].detail, "original")
  assert.equal(result.body.input[0].content[0].text, "Inspect this")
  assert.equal(result.body.input[1].call_id, "call_1")
})

test("leaves external URLs, existing file ids and unsupported images unchanged", async () => {
  const uploader = fakeUploader()
  const body = {
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://example.com/a.jpg" },
        { type: "input_image", file_id: "file-api-existing" },
        { type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zy8+" },
      ],
    }],
  }
  const before = structuredClone(body)

  const result = await externalizeResponsesImages(body, uploader, { logger: silentLogger() })
  assert.deepEqual(result.body, before)
  assert.equal(result.stats.images, 0)
  assert.equal(result.stats.unsupported, 1)
  assert.equal(uploader.calls.length, 0)
})

test("passes through a body with no image parts without replacing it", async () => {
  const uploader = fakeUploader()
  const body = { model: "deepseek-flash", input: "hello" }
  const result = await externalizeResponsesImages(body, uploader, { logger: silentLogger() })
  assert.equal(result.body, body)
  assert.equal(result.stats.images, 0)
  assert.equal(uploader.calls.length, 0)
})

test("does not log image data", async () => {
  const messages = []
  const logger = { warn: (message) => messages.push(message), info: (message) => messages.push(message) }
  const uploader = fakeUploader()
  await externalizeResponsesImages({
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: PNG }] }],
  }, uploader, { logger })
  assert.equal(messages.join("\n").includes(PNG.split(",")[1]), false)
})
