import { extensionForMime, sha256Hex } from "./data-url.mjs"

const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_TIMEOUT_MS = 120_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorTextFromBody(text) {
  if (!text) return ""
  try {
    const parsed = JSON.parse(text)
    return parsed?.error?.message || parsed?.message || text
  } catch {
    return text
  }
}

export class ImageUploader {
  constructor({
    apiKey,
    cache,
    filesUrl = "https://api.deepseek.com/files",
    fetchImpl = globalThis.fetch,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    uploadTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 1,
    retryDelayMs = 750,
    now = Date.now,
    logger = console,
    onImage,
  }) {
    if (!apiKey) throw new Error("ImageUploader needs a DeepSeek API key")
    if (!cache) throw new Error("ImageUploader needs a cache")
    if (typeof fetchImpl !== "function") throw new Error("ImageUploader needs fetch")
    this.apiKey = apiKey
    this.cache = cache
    this.filesUrl = filesUrl
    this.fetchImpl = fetchImpl
    this.ttlSeconds = ttlSeconds
    this.uploadTimeoutMs = uploadTimeoutMs
    this.maxRetries = maxRetries
    this.retryDelayMs = retryDelayMs
    this.now = now
    this.logger = logger
    this.onImage = onImage
    this.inFlight = new Map()
  }

  async resolve({ hash, bytes, mime }, { signal } = {}) {
    if (signal?.aborted) throw abortError(signal)
    const cached = await this.cache.get(hash)
    if (cached?.fileId) {
      await this.remember({ hash, bytes, mime, fileId: cached.fileId })
      return { fileId: cached.fileId, cacheHit: true }
    }

    if (this.inFlight.has(hash)) {
      return { fileId: await this.inFlight.get(hash), cacheHit: true }
    }

    const pending = this.uploadAndCache({ hash, bytes, mime }, { signal })
    this.inFlight.set(hash, pending)
    try {
      const fileId = await pending
      await this.remember({ hash, bytes, mime, fileId })
      return { fileId, cacheHit: false }
    } finally {
      this.inFlight.delete(hash)
    }
  }

  async remember(image) {
    if (typeof this.onImage !== "function") return
    try {
      await this.onImage(image)
    } catch (error) {
      this.logger.warn?.(`deepseek-files: could not keep a local image preview: ${error.message}`)
    }
  }

  async uploadAndCache({ hash, bytes, mime }, { signal } = {}) {
    if (!bytes?.length) throw new Error("DeepSeek Files API received an empty image")
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`DeepSeek Files API image exceeds 64 MiB (${bytes.length} bytes)`)
    }

    const fileId = await this.uploadWithRetry({ hash, bytes, mime }, { signal })
    const createdAt = this.now()
    await this.cache.set(hash, {
      fileId,
      mime,
      bytes: bytes.length,
      createdAt,
      expiresAt: createdAt + this.ttlSeconds * 1000,
    })
    return fileId
  }

  async uploadWithRetry({ hash, bytes, mime }, { signal } = {}) {
    let lastError
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.uploadOnce({ hash, bytes, mime }, { signal })
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw abortError(signal)
        const retryable = error?.retryable === true
        if (!retryable || attempt >= this.maxRetries) throw error
        await sleep(this.retryDelayMs * (attempt + 1))
      }
    }
    throw lastError
  }

  async uploadOnce({ hash, bytes, mime }, { signal } = {}) {
    const form = new FormData()
    form.append("purpose", "user_data")
    form.append("expires_after[anchor]", "created_at")
    form.append("expires_after[seconds]", String(this.ttlSeconds))
    form.append(
      "file",
      new Blob([bytes], { type: mime }),
      `${hash.slice(0, 16)}.${extensionForMime(mime)}`,
    )

    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason || abortError(signal))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error("DeepSeek Files API upload timed out")),
      this.uploadTimeoutMs,
    )
    let response
    try {
      response = await this.fetchImpl(this.filesUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      if (controller.signal.aborted) {
        const timeout = new Error("DeepSeek Files API upload timed out")
        timeout.retryable = true
        throw timeout
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }

    if (response.ok) {
      const payload = await response.json().catch(() => null)
      if (!payload?.id || !String(payload.id).startsWith("file-api-")) {
        throw new Error("DeepSeek Files API returned an invalid file id")
      }
      return payload.id
    }

    const text = await response.text().catch(() => "")
    const detail = errorTextFromBody(text).replace(/\s+/g, " ").slice(0, 1200)
    const message = `DeepSeek Files API upload failed (${response.status})${detail ? `: ${detail}` : ""}`
    const error = new Error(message)
    if (response.status === 401) error.signIn = "expired"
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      error.retryable = true
    }
    this.logger.warn?.(message)
    throw error
  }
}

export async function forgetFileIds(cache, hashes) {
  if (!cache?.deleteMany || !hashes?.length) return
  await cache.deleteMany(hashes)
}

export function accountHashForKey(apiKey) {
  return sha256Hex(Buffer.from(String(apiKey), "utf8"))
}

function abortError(signal) {
  const error = new Error("DeepSeek Files upload was aborted")
  error.name = "AbortError"
  if (signal?.reason) error.cause = signal.reason
  return error
}
