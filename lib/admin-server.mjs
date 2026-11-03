import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sharedCache } from "./cache.mjs"
import { SUPPORTED_IMAGE_MIMES, sha256Hex } from "./data-url.mjs"
import { createMediaStore, defaultDataDir, defaultImagesDir } from "./media.mjs"
import { readStatus } from "./status.mjs"
import { accountHashForKey, ImageUploader } from "./upload.mjs"

const PROVIDER_ID = "deepseek-files"
const MAX_UPLOAD = 64 * 1024 * 1024
const UI_ROOT = fileURLToPath(new URL("../admin/", import.meta.url))
const TOKEN_HEADER = ["x", "deepseek", "files", "token"].join("-")

const STATIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
])

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}

function text(response, status, value, type = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(value)
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return result === 0
}

function readOrCreateToken(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const tokenPath = join(dataDir, "admin-token")
  try {
    const saved = readFileSync(tokenPath, "utf8").trim()
    if (/^[a-f0-9]{64}$/.test(saved)) return saved
  } catch {}
  const token = randomBytes(32).toString("hex")
  writeFileSync(tokenPath, token, { mode: 0o600 })
  chmodSync(tokenPath, 0o600)
  return token
}

function corsHeaders(request, port) {
  const origin = request.headers.origin
  const own = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const allow = origin === "null" ? "null" : origin && own.has(origin) ? origin : "null"
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "vary": "Origin",
  }
}

function readAuthKey(authPath) {
  return readFile(authPath, "utf8").then((source) => {
    const all = JSON.parse(source)
    const keys = Object.keys(all).filter((key) => key === PROVIDER_ID || key.startsWith(`${PROVIDER_ID}#`))
    for (const key of keys) {
      const value = all[key]
      if (value?.type === "api" && typeof value.key === "string" && value.key.trim()) {
        return { key: value.key.trim(), accountId: key }
      }
    }
    return null
  }).catch(() => null)
}

function readRaw(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"])
    if (Number.isFinite(declared) && declared > limit) {
      const error = new Error("File is larger than 64 MiB")
      error.status = 413
      reject(error)
      request.resume()
      return
    }
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error("File is larger than 64 MiB")
        error.status = 413
        reject(error)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

function mimeFromName(name) {
  const ext = String(name || "").toLowerCase().split(".").pop()
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    default: return "application/octet-stream"
  }
}

function cleanFileName(value) {
  try {
    return decodeURIComponent(String(value || "")).replace(/[\u0000-\u001f]/g, "").slice(0, 200)
  } catch {
    return ""
  }
}

function relativeTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "未知"
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86400)} 天前`
}

function entryView(hash, entry, hasLocal, token) {
  return {
    hash,
    fileId: entry.fileId,
    mime: entry.mime,
    bytes: entry.bytes,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    hasLocal,
    previewUrl: hasLocal ? `/api/image/${hash}?token=${encodeURIComponent(token)}` : null,
    createdAgo: relativeTime(entry.createdAt),
  }
}

async function deleteRemote(fileId, apiKey, fetchImpl, filesUrl) {
  const response = await fetchImpl(`${filesUrl.replace(/\/+$/, "")}/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (response.status === 404 || response.ok) return
  const body = await response.text().catch(() => "")
  throw Object.assign(new Error(`DeepSeek 删除文件失败（HTTP ${response.status}）${body ? `: ${body.slice(0, 300)}` : ""}`), {
    status: response.status === 401 ? 401 : 502,
  })
}

export function startAdminService({
  port = 3486,
  host = "127.0.0.1",
  dataDir = defaultDataDir(),
  cachePath = join(dataDir, "cache.json"),
  imagesDir = defaultImagesDir(),
  authPath = join(dataDir, "..", "plugin-auth.json"),
  statusPath = join(dataDir, "status.json"),
  filesUrl = "https://api.deepseek.com/files",
  fetchImpl = globalThis.fetch,
  pluginVersion = "",
  logger = console,
} = {}) {
  const token = readOrCreateToken(dataDir)
  const media = createMediaStore({ dir: imagesDir, logger })
  let actualPort = port
  let attempts = 0
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      logger.warn?.(`deepseek-files admin: ${error.message}`)
      if (response.headersSent) response.destroy()
      else json(response, error.status || 500, { error: error.message })
    })
  })

  async function handle(request, response) {
    const url = new URL(request.url || "/", `http://${host}:${actualPort}`)
    const hostValue = String(request.headers.host || "").toLowerCase()
    const ownOrigin = `http://${host}:${actualPort}`
    const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`])
    if (!allowedHosts.has(hostValue)) return json(response, 403, { error: "Bad Host" })
    const origin = request.headers.origin
    if (origin !== undefined && origin !== "null" && origin !== ownOrigin) {
      return json(response, 403, { error: "Bad Origin" })
    }
    if (url.pathname.startsWith("/api/")) {
      for (const [name, value] of Object.entries(corsHeaders(request, actualPort))) {
        response.setHeader(name, value)
      }
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": response.getHeader("access-control-allow-origin") || "null",
        "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "vary": "Origin",
      })
      response.end()
      return
    }

    if (request.method === "GET" && STATIC.has(url.pathname)) {
      const [file, type] = STATIC.get(url.pathname)
      let body = await readFile(join(UI_ROOT, file))
      if (file === "index.html") {
        const css = await readFile(join(UI_ROOT, "styles.css"), "utf8")
        const js = await readFile(join(UI_ROOT, "app.js"), "utf8")
        body = Buffer.from(body.toString("utf8")
          .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
          .replace('<script src="/app.js" defer></script>', `<script>${js}</script>`)
          .replaceAll("__DEEPSEEK_FILES_TOKEN__", token))
      }
      response.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": [
          `default-src http://127.0.0.1:${actualPort} http://localhost:${actualPort}`,
          `connect-src http://127.0.0.1:${actualPort} http://localhost:${actualPort}`,
          `img-src http://127.0.0.1:${actualPort} http://localhost:${actualPort} data:`,
          `style-src http://127.0.0.1:${actualPort} http://localhost:${actualPort} 'unsafe-inline'`,
          `script-src http://127.0.0.1:${actualPort} http://localhost:${actualPort} 'unsafe-inline'`,
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      })
      response.end(body)
      return
    }

    if (!url.pathname.startsWith("/api/")) return json(response, 404, { error: "Not found" })

    if (url.pathname.startsWith("/api/image/")) {
      if (!safeEqual(url.searchParams.get("token") || "", token)) {
        return json(response, 401, { error: "Unauthorized", reload: true })
      }
      const hash = url.pathname.slice("/api/image/".length)
      if (!/^[a-f0-9]{64}$/.test(hash)) return json(response, 400, { error: "Bad image id" })
      const auth = await readAuthKey(authPath)
      if (!auth) return json(response, 401, { error: "DeepSeek 未登录" })
      const cache = sharedCache({ filePath: cachePath, accountHash: accountHashForKey(auth.key), logger })
      const entry = (await cache.snapshot())[hash]
      if (!entry) return json(response, 404, { error: "图片不在缓存中" })
      const bytes = await media.read(hash)
      if (!bytes) return json(response, 404, { error: "没有本地预览" })
      response.writeHead(200, {
        "content-type": entry.mime || "application/octet-stream",
        "content-length": bytes.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      })
      response.end(bytes)
      return
    }

    if (!safeEqual(String(request.headers[TOKEN_HEADER] || ""), token)) {
      return json(response, 401, { error: "Unauthorized", reload: true })
    }

    const auth = await readAuthKey(authPath)
    const cache = auth
      ? sharedCache({ filePath: cachePath, accountHash: accountHashForKey(auth.key), logger })
      : null

    if (request.method === "GET" && url.pathname === "/api/status") {
      const entries = cache ? await cache.snapshot() : {}
      const hashes = Object.keys(entries)
      let localPreviews = 0
      let totalBytes = 0
      for (const hash of hashes) {
        totalBytes += Number(entries[hash].bytes) || 0
        if (await media.has(hash)) localPreviews++
      }
      const lastRequest = await readStatus({ filePath: statusPath })
      return json(response, 200, {
        active: true,
        signedIn: Boolean(auth),
        provider: PROVIDER_ID,
        model: "deepseek-files/deepseek-flash",
        account: auth ? accountHashForKey(auth.key).slice(0, 12) : null,
        entries: hashes.length,
        totalBytes,
        localPreviews,
        cachePath,
        imagesDir,
        pluginVersion,
        lastRequest,
      })
    }

    if (request.method === "GET" && url.pathname === "/api/images") {
      const entries = cache ? await cache.snapshot() : {}
      const items = []
      for (const [hash, entry] of Object.entries(entries)) {
        const hasLocal = await media.has(hash)
        items.push(entryView(hash, entry, hasLocal, token))
      }
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return json(response, 200, { items, signedIn: Boolean(auth) })
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      if (!auth || !cache) return json(response, 401, { error: "DeepSeek 未登录" })
      let bytes
      try {
        bytes = await readRaw(request, MAX_UPLOAD)
      } catch (error) {
        if (!response.headersSent) json(response, error.status || 400, { error: error.message })
        return
      }
      if (!bytes.length) return json(response, 400, { error: "没有收到图片" })
      const declared = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase()
      const fileName = cleanFileName(request.headers["x-file-name"])
      const mime = SUPPORTED_IMAGE_MIMES.has(declared) ? declared : mimeFromName(fileName)
      if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
        return json(response, 415, { error: "只支持 JPEG、PNG、GIF、WebP" })
      }
      const hash = sha256Hex(bytes)
      const uploader = new ImageUploader({
        apiKey: auth.key,
        cache,
        filesUrl,
        fetchImpl,
        logger,
        onImage: (image) => media.save(image),
      })
      const result = await uploader.resolve({ hash, bytes, mime })
      const entry = (await cache.snapshot())[hash]
      return json(response, 200, {
        ok: true,
        cacheHit: result.cacheHit,
        item: entryView(hash, entry, await media.has(hash), token),
      })
    }

    const match = /^\/api\/images\/([a-f0-9]{64})$/.exec(url.pathname)
    if (match && request.method === "DELETE") {
      if (!auth || !cache) return json(response, 401, { error: "DeepSeek 未登录" })
      const hash = match[1]
      const entry = (await cache.snapshot())[hash]
      if (!entry) return json(response, 404, { error: "图片不在缓存中" })
      await deleteRemote(entry.fileId, auth.key, fetchImpl, filesUrl)
      await cache.delete(hash)
      await media.remove(hash)
      return json(response, 200, { ok: true })
    }

    return json(response, 404, { error: "Not found" })
  }

  function listen() {
    attempts++
    const onError = (error) => {
      server.off("listening", onListening)
      if (error?.code === "EADDRINUSE" && attempts < 60) {
        setTimeout(listen, 500)
        return
      }
      logger.error?.(`deepseek-files admin: could not listen on 127.0.0.1:${port}: ${error.message}`)
      rejectReady(error)
    }
    const onListening = () => {
      server.off("error", onError)
      actualPort = server.address().port
      resolveReady({ port: actualPort, listening: true })
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  }

  listen()
  return {
    token,
    ready,
    get port() { return actualPort },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

export const adminInternal = {
  PROVIDER_ID,
  TOKEN_HEADER,
}
