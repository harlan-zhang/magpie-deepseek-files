import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { FileIdCache } from "../lib/cache.mjs"

test("cache persists file ids and expires entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-cache-"))
  const filePath = join(dir, "cache.json")
  let now = 1_000
  const cache = new FileIdCache({ filePath, accountHash: "account-a", now: () => now })
  await cache.set("image-a", {
    fileId: "file-api-a",
    mime: "image/png",
    bytes: 3,
    expiresAt: 2_000,
  })
  await cache.flush()

  const reloaded = new FileIdCache({ filePath, accountHash: "account-a", now: () => now })
  assert.equal((await reloaded.get("image-a")).fileId, "file-api-a")

  now = 2_001
  assert.equal(await reloaded.get("image-a"), null)
  await reloaded.flush()

  const mode = (await stat(filePath)).mode & 0o777
  assert.equal(mode, 0o600)
  const text = await readFile(filePath, "utf8")
  assert.equal(text.includes("image-a"), false)
  assert.equal(text.includes("file-api-a"), false)
  await rm(dir, { recursive: true, force: true })
})

test("cache namespaces accounts by hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-cache-"))
  const filePath = join(dir, "cache.json")
  const first = new FileIdCache({ filePath, accountHash: "account-a" })
  const second = new FileIdCache({ filePath, accountHash: "account-b" })
  await first.set("same-image", { fileId: "file-api-a", mime: "image/png", bytes: 1, expiresAt: Date.now() + 60_000 })
  await first.flush()
  assert.equal(await second.get("same-image"), null)

  await second.set("same-image", { fileId: "file-api-b", mime: "image/png", bytes: 1, expiresAt: Date.now() + 60_000 })
  await second.flush()
  const reloadedFirst = new FileIdCache({ filePath, accountHash: "account-a" })
  const reloadedSecond = new FileIdCache({ filePath, accountHash: "account-b" })
  assert.equal((await reloadedFirst.get("same-image")).fileId, "file-api-a")
  assert.equal((await reloadedSecond.get("same-image")).fileId, "file-api-b")
  await rm(dir, { recursive: true, force: true })
})

test("cache survives a corrupt file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ds-files-cache-"))
  const filePath = join(dir, "cache.json")
  await writeFile(filePath, "{")
  const warnings = []
  const cache = new FileIdCache({
    filePath,
    accountHash: "account-a",
    logger: { warn: (message) => warnings.push(message) },
  })
  assert.equal(await cache.get("missing"), null)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].includes("iVBOR"), false)
  await rm(dir, { recursive: true, force: true })
})
