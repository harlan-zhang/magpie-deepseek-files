import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sharedCache, defaultCachePath } from "./lib/cache.mjs"
import { accountHashForKey, forgetFileIds, ImageUploader } from "./lib/upload.mjs"
import { externalizeResponsesImages } from "./lib/transform.mjs"
import { createMediaStore, defaultDataDir } from "./lib/media.mjs"
import { recordStatus, defaultStatusPath } from "./lib/status.mjs"
import { startAdminService } from "./lib/admin-server.mjs"

export const PROVIDER_ID = "deepseek-files"
export const MODEL_ID = "deepseek-flash"

const OFFICIAL_BASE_URL = "https://api.deepseek.com/v1"
const LIMIT_BYTES = 48 * 1024 * 1024
const DEFAULT_PAGE_PORT = 3486
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")).version || ""
  } catch {
    return ""
  }
})()

function requestUrl(input) {
  if (typeof input === "string") return new URL(input)
  if (input instanceof URL) return input
  if (input && typeof input === "object" && typeof input.url === "string") return new URL(input.url)
  return null
}

function bodyText(body) {
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }
  return null
}

function filesUrlFromBase(baseUrl) {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "") + "/files"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

function numberOption(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function modelConfig() {
  return {
    id: MODEL_ID,
    name: "DeepSeek V4.1 Flash (Files API)",
    limit: { context: 1_048_576, output: 393_216 },
    modalities: { input: ["text", "image"] },
    reasoning: true,
    tool_call: true,
    variants: { low: {}, high: {}, max: {} },
  }
}

function isMissingFileError(status, text) {
  if (status !== 400 && status !== 404) return false
  return /file[_-]?id|file not found|file.*(deleted|expired|invalid)/i.test(text)
}

async function createHooks(_input = {}, pluginOptions = {}) {
  const baseUrl = String(pluginOptions.baseUrl || OFFICIAL_BASE_URL).replace(/\/+$/, "")
  const fetchImpl = pluginOptions.fetchImpl || globalThis.fetch
  const logger = pluginOptions.logger || console
  const cachePath = pluginOptions.cachePath || defaultCachePath()
  const statusPath = pluginOptions.statusPath || defaultStatusPath()
  const media = createMediaStore({ logger })
  const filesUrl = pluginOptions.filesUrl || filesUrlFromBase(baseUrl)
  const ttlSeconds = numberOption(pluginOptions.ttlSeconds, 30 * 24 * 60 * 60, 3600, 30 * 24 * 60 * 60)
  const maxConcurrency = numberOption(pluginOptions.maxConcurrency, 3, 1, 8)
  const uploadTimeoutMs = numberOption(pluginOptions.uploadTimeoutMs, 120_000, 1000, 600_000)
  const maxBodyBytes = numberOption(pluginOptions.maxBodyBytes, LIMIT_BYTES, 1024, 256 * 1024 * 1024)

  return {
    config: async (config) => {
      config.provider ??= {}
      const provider = config.provider[PROVIDER_ID] ??= {}
      provider.name ??= "DeepSeek Files"
      provider.npm ??= "@ai-sdk/openai"
      provider.api ??= baseUrl
      provider.models ??= {}
      provider.models[MODEL_ID] = {
        ...modelConfig(),
        ...(provider.models[MODEL_ID] ?? {}),
      }
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [{
        type: "api",
        label: "DeepSeek API key",
        placeholder: "sk-...",
      }],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) {
          throw Object.assign(new Error("A DeepSeek API key is required"), { signIn: "expired" })
        }
        const apiKey = String(auth.key).trim()
        const cache = sharedCache({
          filePath: cachePath,
          accountHash: accountHashForKey(apiKey),
          logger,
        })
        const uploader = new ImageUploader({
          apiKey,
          cache,
          filesUrl,
          fetchImpl,
          ttlSeconds,
          uploadTimeoutMs,
          logger,
          onImage: (image) => media.save(image),
        })

        return {
          baseURL: baseUrl,
          apiKey,
          async fetch(input, init) {
            const url = requestUrl(input)
            if (!url || !url.pathname.endsWith("/responses")) {
              return fetchImpl(input, init)
            }

            const original = bodyText(init?.body)
            if (original === null) return fetchImpl(input, init)

            let body
            try {
              body = JSON.parse(original)
            } catch {
              return fetchImpl(input, init)
            }

            const { stats, hashes } = await externalizeResponsesImages(body, uploader, {
              logger,
              maxConcurrency,
              signal: init?.signal,
            })
            if (!stats.images) return fetchImpl(input, init)

            const send = async (requestBody, summary) => {
              const nextBody = JSON.stringify(requestBody)
              const nextBytes = new TextEncoder().encode(nextBody).byteLength
              if (nextBytes >= maxBodyBytes) {
                throw new Error(
                  `DeepSeek request is still ${formatMiB(nextBytes)} after image externalization; the limit is ${formatMiB(maxBodyBytes)}`,
                )
              }

              const headers = new Headers(init?.headers || {})
              headers.delete("content-length")
              if (!headers.has("content-type")) headers.set("content-type", "application/json")

              logger.info?.(
                `deepseek-files: images=${summary.images} unique=${summary.unique} uploaded=${summary.uploads} cacheHits=${summary.cacheHits} body=${formatMiB(new TextEncoder().encode(original).byteLength)}->${formatMiB(nextBytes)}`,
              )
              void recordStatus({
                provider: PROVIDER_ID,
                model: MODEL_ID,
                images: summary.images,
                unique: summary.unique,
                uploads: summary.uploads,
                cacheHits: summary.cacheHits,
                bodyBeforeBytes: new TextEncoder().encode(original).byteLength,
                bodyAfterBytes: nextBytes,
              }, { filePath: statusPath, logger })

              return fetchImpl(input, { ...init, headers, body: nextBody })
            }

            let response = await send(body, stats)
            if (response.status !== 400 && response.status !== 404) return response

            const text = await response.clone().text().catch(() => "")
            if (!isMissingFileError(response.status, text) || !hashes?.length) return response

            logger.warn?.("deepseek-files: a cached file id was rejected; refreshing image files and retrying once")
            await forgetFileIds(cache, hashes)
            const retryBody = JSON.parse(original)
            const retry = await externalizeResponsesImages(retryBody, uploader, {
              logger,
              maxConcurrency,
              signal: init?.signal,
            })
            return send(retryBody, retry.stats)
          },
        }
      },
    },
  }
}

let adminService = null

function ensureAdminService(pluginOptions = {}) {
  if (adminService) return adminService
  const logger = pluginOptions.logger || console
  const baseUrl = String(pluginOptions.baseUrl || OFFICIAL_BASE_URL).replace(/\/+$/, "")
  const port = numberOption(pluginOptions.port, DEFAULT_PAGE_PORT, 1024, 65535)
  try {
    adminService = startAdminService({
      port,
      cachePath: pluginOptions.cachePath || defaultCachePath(),
      imagesDir: join(defaultDataDir(), "images"),
      authPath: join(defaultDataDir(), "..", "plugin-auth.json"),
      statusPath: pluginOptions.statusPath || defaultStatusPath(),
      filesUrl: pluginOptions.filesUrl || filesUrlFromBase(baseUrl),
      fetchImpl: pluginOptions.fetchImpl || globalThis.fetch,
      pluginVersion: PLUGIN_VERSION,
      logger,
    })
    adminService.ready.then(
      (info) => logger.info?.(`deepseek-files: management page on http://127.0.0.1:${info.port}/`),
      (error) => logger.error?.(`deepseek-files: management page failed: ${error.message}`),
    )
  } catch (error) {
    logger.error?.(`deepseek-files: management page could not start: ${error.message}`)
    adminService = null
  }
  return adminService
}

export default {
  id: PROVIDER_ID,
  async server(input = {}, options = {}) {
    if (options.adminService !== false) ensureAdminService(options)
    return createHooks(input, options)
  },
}
