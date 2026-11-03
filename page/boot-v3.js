(async () => {
  const DEFAULT_PORT = 3486;
  let port = DEFAULT_PORT;
  let service = "";
  let theme = "";
  let tokens = null;

  try {
    const t = await window.magpie?.ready;
    if (t) {
      if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
      if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
    }
  } catch {}
  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch {}
  try {
    const options = await window.magpie?.options?.get?.();
    if (Number.isFinite(Number(options?.port)) && Number(options.port) > 0) port = Number(options.port);
  } catch {}

  const query = new URLSearchParams();
  if (theme) query.set("theme", theme);
  query.set("ts", String(Date.now()));
  const slim = {};
  for (const [key, value] of Object.entries(tokens || {})) {
    const text = String(value ?? "").trim();
    if (text) slim[key] = text;
  }
  if (Object.keys(slim).length) {
    try { query.set("tokens", btoa(unescape(encodeURIComponent(JSON.stringify(slim))))); } catch {}
  }

  function armTimeout(targetPort) {
    setTimeout(() => {
      const said = document.getElementById("said");
      if (!said) return;
      said.textContent = `本地图片管理服务没有运行（127.0.0.1:${targetPort}）`;
      if (document.getElementById("retry")) return;
      const button = document.createElement("button");
      button.id = "retry";
      button.type = "button";
      button.textContent = "重试";
      button.addEventListener("click", () => location.reload());
      said.parentNode.append(button);
    }, 5000);
  }

  if (service) {
    armTimeout(port);
    location.replace(service + "?" + query.toString());
    return;
  }

  const target = `http://127.0.0.1:${port}/?${query.toString()}`;
  armTimeout(port);
  location.replace(target);
})();
