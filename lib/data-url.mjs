import { createHash } from "node:crypto"

export const SUPPORTED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/i
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export function parseImageDataUrl(value) {
  if (typeof value !== "string") return null
  const match = DATA_URL.exec(value)
  if (!match) return null

  const mime = match[1].trim().toLowerCase()
  let base64 = match[2].replace(/\s+/g, "")
  if (!BASE64.test(base64)) return null
  if (!SUPPORTED_IMAGE_MIMES.has(mime)) return { mime, bytes: null, supported: false }
  if (!base64.length) return null

  const padding = base64.length % 4
  if (padding === 1) return null
  if (padding) base64 += "=".repeat(4 - padding)

  const bytes = Buffer.from(base64, "base64")
  if (!bytes.length) return null
  return { mime, bytes, supported: true }
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function extensionForMime(mime) {
  switch (mime) {
    case "image/jpeg": return "jpg"
    case "image/png": return "png"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    default: return "bin"
  }
}
