const token = document.body.dataset.token || "";
const authHeaders = { "x-deepseek-files-token": token };
const $ = (selector) => document.querySelector(selector);
let allItems = [];
let noticeTimer = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatTime(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "–";
  return new Date(Number(timestamp)).toLocaleString("zh-CN", { hour12: false });
}

function formatAgo(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "–";
  const sec = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时前`;
  return `${Math.round(sec / 86400)} 天前`;
}

function showNotice(message, error = false) {
  const node = $("#notice");
  node.hidden = false;
  node.classList.toggle("error", error);
  node.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { node.hidden = true; }, 7000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.reload && (response.status === 401 || response.status === 403)) {
      location.replace(`${location.pathname}?ts=${Date.now()}`);
      return new Promise(() => {});
    }
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function renderStatus(status) {
  const dot = $("#active-dot");
  dot.className = "status-dot on";
  $("#active-label").textContent = "已生效";
  $("#stat-active").textContent = status.active ? "运行中" : "未运行";
  $("#stat-version").textContent = status.pluginVersion ? `v${status.pluginVersion}` : "本地插件";
  $("#stat-auth").textContent = status.signedIn ? "已登录" : "未登录";
  $("#stat-account").textContent = status.account ? `账号 ${status.account}…` : "请在 Magpie 插件页登录";
  $("#stat-count").textContent = String(status.entries ?? 0);
  $("#stat-local").textContent = `${status.localPreviews ?? 0} 张有本地预览`;
  $("#stat-size").textContent = formatBytes(status.totalBytes);
  $("#paths").textContent = `缓存：${status.cachePath} · 本地预览：${status.imagesDir}`;

  const last = status.lastRequest;
  $("#last-time").textContent = last?.updatedAt ? `${formatAgo(last.updatedAt)} · ${formatTime(last.updatedAt)}` : "暂无记录";
  const values = last ? [
    ["图片", last.images ?? 0],
    ["唯一图片", last.unique ?? 0],
    ["本次上传", last.uploads ?? 0],
    ["缓存命中", last.cacheHits ?? 0],
    ["请求体", formatBytes(last.bodyBeforeBytes)],
    ["外置后", formatBytes(last.bodyAfterBytes)],
  ] : [
    ["图片", "–"], ["唯一图片", "–"], ["本次上传", "–"],
    ["缓存命中", "–"], ["请求体", "–"], ["外置后", "–"],
  ];
  const grid = $("#last-grid");
  grid.replaceChildren(...values.map(([label, value]) => {
    const wrap = el("div");
    wrap.append(el("span", "", label), el("strong", "", String(value)));
    return wrap;
  }));
}

function itemMatches(item, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.hash.includes(q) || String(item.fileId).toLowerCase().includes(q);
}

function renderImages(items) {
  const query = $("#search").value.trim();
  const visible = items.filter((item) => itemMatches(item, query));
  const grid = $("#images");
  grid.replaceChildren(...visible.map(renderCard));
  $("#empty").hidden = visible.length > 0;
  if (!visible.length && items.length) {
    $("#empty strong").textContent = "没有匹配的图片";
    $("#empty span").textContent = "换个 hash 或 file id 试试。";
  } else {
    $("#empty strong").textContent = "还没有记录到图片";
    $("#empty span").textContent = "在 Codex 里发送图片后，这里会出现外置记录。";
  }
}

function renderCard(item) {
  const card = el("article", "card");
  const thumb = el("div", "thumb");
  if (item.hasLocal && item.previewUrl) {
    const image = el("img");
    image.loading = "lazy";
    image.alt = `图片 ${item.hash.slice(0, 12)}`;
    image.src = item.previewUrl;
    thumb.append(image);
  } else {
    thumb.append(el("div", "placeholder", "本地预览待补齐\n下次请求该图片后自动保存"));
  }

  const body = el("div", "card-body");
  body.append(
    el("div", "hash", `${item.hash.slice(0, 16)}…`),
    el("div", "meta", `${item.mime || "image"} · ${formatBytes(item.bytes)}`),
    el("div", "sub", `创建 ${item.createdAgo || formatAgo(item.createdAt)} · ${formatTime(item.createdAt)}`),
    el("div", "sub", `过期 ${formatTime(item.expiresAt)}`),
  );
  const fileId = el("div", "sub", `file_id: ${item.fileId}`);
  fileId.title = item.fileId;
  body.append(fileId);

  const actions = el("div", "card-actions");
  const copy = el("button", "button ghost", "复制 file_id");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(item.fileId);
      showNotice("已复制 file_id");
    } catch {
      showNotice("复制失败", true);
    }
  });
  const remove = el("button", "button danger", "删除");
  remove.type = "button";
  remove.addEventListener("click", () => deleteItem(item, remove));
  actions.append(copy, remove);
  body.append(actions);
  card.append(thumb, body);
  return card;
}

async function deleteItem(item, button) {
  const ok = confirm(`从 DeepSeek 删除这张图片？\n\n${item.fileId}\n\n历史对话如果再次需要它，会自动重新上传。`);
  if (!ok) return;
  button.disabled = true;
  try {
    await api(`/api/images/${item.hash}`, { method: "DELETE" });
    showNotice("图片已从 DeepSeek 和本地缓存删除");
    await load();
  } catch (error) {
    showNotice(error.message, true);
    button.disabled = false;
  }
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let done = 0;
  for (const file of files) {
    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name || "upload"),
        },
        body: file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      done++;
      showNotice(data.cacheHit ? `${file.name} 已存在，命中缓存` : `${file.name} 已上传到 DeepSeek Files`);
    } catch (error) {
      showNotice(`${file.name}: ${error.message}`, true);
    }
  }
  if (done) await load();
}

async function load() {
  try {
    const [status, images] = await Promise.all([
      api("/api/status"),
      api("/api/images"),
    ]);
    renderStatus(status);
    allItems = images.items || [];
    renderImages(allItems);
  } catch (error) {
    $("#active-dot").className = "status-dot off";
    $("#active-label").textContent = "不可用";
    $("#stat-active").textContent = "连接失败";
    showNotice(error.message, true);
  }
}

$("#refresh").addEventListener("click", load);
$("#search").addEventListener("input", () => renderImages(allItems));
$("#pick").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", (event) => {
  uploadFiles(event.target.files);
  event.target.value = "";
});

const drop = $("#drop");
for (const eventName of ["dragenter", "dragover"]) {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (event) => uploadFiles(event.dataTransfer.files));

load();
setInterval(load, 15000);
