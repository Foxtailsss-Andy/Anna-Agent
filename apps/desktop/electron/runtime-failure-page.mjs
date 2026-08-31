export function runtimeFailureHtml({ message, details } = {}) {
  const safeMessage = escapeHtml(redactSecrets(message || "Anna Preview Host could not start"));
  const safeDetails = escapeHtml(redactSecrets(details || ""));
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Anna Preview 启动失败</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f6f8fb;
        color: #172033;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(720px, calc(100vw - 48px));
        border: 1px solid #d9e0ea;
        border-radius: 8px;
        background: #ffffff;
        padding: 28px;
        box-shadow: 0 18px 48px rgba(23, 32, 51, 0.12);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 24px;
      }
      p {
        margin: 0 0 16px;
        line-height: 1.6;
        color: #526174;
      }
      code, pre {
        border-radius: 6px;
        background: #f0f4f8;
      }
      code {
        padding: 2px 6px;
      }
      pre {
        overflow: auto;
        padding: 12px;
        color: #233044;
      }
      ul {
        margin: 12px 0 0;
        padding-left: 20px;
        color: #526174;
      }
      button {
        border: 0;
        border-radius: 6px;
        padding: 10px 16px;
        background: #1769e0;
        color: #ffffff;
        cursor: pointer;
        font: inherit;
      }
      button:disabled {
        cursor: wait;
        opacity: 0.65;
      }
      #restart-status {
        min-height: 1.4em;
        margin: 10px 0 0;
        color: #a33b2d;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Anna Preview 启动失败</h1>
      <p>${safeMessage}</p>
      ${safeDetails ? `<pre>${safeDetails}</pre>` : ""}
      <button id="restart-runtime" type="button">重启 Preview</button>
      <p id="restart-status" role="status"></p>
      <p>请检查 Preview Host、端口占用和本地配置路径。</p>
      <ul>
        <li><code>ANNA_PREVIEW_ENTRY_PATH</code> 可指定 Preview Host 入口。</li>
        <li><code>ANNA_PREVIEW_CONFIG_PATH</code> 可指定 Preview 模型配置文件。</li>
        <li><code>ANNA_PREVIEW_STATE_ROOT</code> 可指定 Preview 本地状态目录。</li>
      </ul>
    </main>
    <script>
      const restartButton = document.getElementById("restart-runtime");
      const restartStatus = document.getElementById("restart-status");
      restartButton.addEventListener("click", async () => {
        restartButton.disabled = true;
          restartButton.textContent = "重启中...";
        restartStatus.textContent = "";
        try {
          if (!window.__ANNA_RUNTIME__ || typeof window.__ANNA_RUNTIME__.restartRuntime !== "function") {
            throw new Error("当前页面没有桌面运行时重启能力");
          }
          const result = await window.__ANNA_RUNTIME__.restartRuntime();
          const destination = result && (result.appUrl || result.apiBase);
          if (!destination) throw new Error("运行时已重启，但没有可用页面地址");
          window.location.assign(destination);
        } catch (error) {
          const message = String(error)
            .replace(/Bearer\\s+[^\\s]+/gi, "Bearer [redacted]")
            .replace(/(api[_-]?key|token|secret|password)[\\s=:]+[^\\s]+/gi, "$1=[redacted]");
          restartButton.disabled = false;
          restartButton.textContent = "重试重启";
          restartStatus.textContent = message;
        }
      });
    </script>
  </body>
</html>`;
}

export function runtimeFailureDataUrl(error) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(runtimeFailureHtml(error))}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redactSecrets(value) {
  return String(value)
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|client[_-]?secret|secret|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(ANNA_MODEL_API_KEY\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key[\"':=\s]+)[^,\"'\s]+/gi, "$1[redacted]")
    .replace(/(secret[\"':=\s]+)[^,\"'\s]+/gi, "$1[redacted]");
}
