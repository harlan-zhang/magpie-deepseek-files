import { parseImageDataUrl, sha256Hex } from "./data-url.mjs"

async function mapLimit(items, limit, work) {
  let next = 0
  const results = new Array(items.length)
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export async function externalizeResponsesImages(body, uploader, {
  logger = console,
  maxConcurrency = 3,
  signal,
} = {}) {
  const stats = {
    images: 0,
    unique: 0,
    updated: 0,
    uploads: 0,
    cacheHits: 0,
    inlineBytes: 0,
    unsupported: 0,
    invalid: 0,
  }
  const occurrences = []
  const unique = new Map()
  const visited = new WeakSet()

  function visit(value) {
    if (!value || typeof value !== "object") return
    if (visited.has(value)) return
    visited.add(value)

    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    if (value.type === "input_image"
      && !value.file_id
      && typeof value.image_url === "string"
      && value.image_url.startsWith("data:image/")) {
      const parsed = parseImageDataUrl(value.image_url)
      if (!parsed) {
        stats.invalid++
        logger.warn?.("deepseek-files: left an invalid image data URL unchanged")
      } else if (!parsed.supported) {
        stats.unsupported++
        logger.warn?.(`deepseek-files: left unsupported image type ${parsed.mime} unchanged`)
      } else {
        const hash = sha256Hex(parsed.bytes)
        stats.images++
        stats.inlineBytes += parsed.bytes.length
        occurrences.push({ part: value, hash })
        if (!unique.has(hash)) {
          unique.set(hash, { hash, bytes: parsed.bytes, mime: parsed.mime })
        }
      }
    }

    for (const child of Object.values(value)) visit(child)
  }

  visit(body)
  stats.unique = unique.size
  if (!occurrences.length) return { body, stats }

  const resolved = new Map()
  await mapLimit([...unique.values()], Math.max(1, maxConcurrency), async (image) => {
    const result = await uploader.resolve(image, { signal })
    resolved.set(image.hash, result)
    if (result.cacheHit) stats.cacheHits++
    else stats.uploads++
  })

  for (const occurrence of occurrences) {
    const result = resolved.get(occurrence.hash)
    if (!result?.fileId) throw new Error("DeepSeek Files API did not return a file id")
    delete occurrence.part.image_url
    occurrence.part.file_id = result.fileId
    stats.updated++
  }

  return { body, stats, hashes: [...unique.keys()] }
}
