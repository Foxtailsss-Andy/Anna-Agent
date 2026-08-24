/**
 * LoginPage · 登录页(《R3 外壳》Task 3)
 *
 * session/current 返回未认证或本机默认身份时由引导流唤出,登录成功后再进入外壳。
 * 本机默认身份仍预填 boss@anna.demo / crew-demo,远程未认证时保持空白。
 */

import { useState } from "react";

import annaPortrait from "../../assets/anna-login-portrait.png";
import { StateNote } from "../../components/anna/StateNote";
import { getIdentity, setToken, type AnnaIdentity } from "../../lib/api/identity";
import { apiUrl } from "../../lib/runtime";
import { applyTheme, loadTheme, type ThemeMode } from "../../lib/theme";
import "./LoginPage.css";

const DEV = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

export function LoginPage({
  onDone,
  prefillDemo = DEV,
}: {
  onDone: (identity: AnnaIdentity) => void;
  prefillDemo?: boolean;
}) {
  const [email, setEmail] = useState(prefillDemo ? "boss@anna.demo" : "");
  const [password, setPassword] = useState(prefillDemo ? "crew-demo" : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());

  const toggleTheme = () => {
    const next: ThemeMode = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        // 本机默认服务可能没有 auth route,仅对预填演示凭据回落到本机身份。
        if (
          res.status === 404
          && prefillDemo
          && email.trim() === "boss@anna.demo"
          && password === "crew-demo"
        ) {
          const localIdentity = await getIdentity(true);
          if (localIdentity.source === "local-runtime") {
            onDone(localIdentity);
            return;
          }
        }
        let message = `auth/login ${res.status}`;
        try {
          const body = (await res.json()) as { detail?: string };
          if (body.detail) message = body.detail;
        } catch {
          /* 非 JSON 错误体:保留状态码文案 */
        }
        setError(message);
        return;
      }
      const body = (await res.json()) as { token: string };
      setToken(body.token);
      const identity = await getIdentity(true);
      onDone(identity);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ir-login">
      <div className="ir-login__corner-mark" aria-hidden="true">
        <span className="ir-login__corner-name">Anna</span>
        <span className="ir-login__corner-meta">CREW / 01</span>
      </div>

      <button
        type="button"
        className="ir-login__theme"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
      >
        {theme === "dark" ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M20.3 15.6A8.5 8.5 0 0 1 8.4 3.7 8.5 8.5 0 1 0 20.3 15.6Z" />
          </svg>
        )}
      </button>

      <div className="ir-login__layout">
        <section className="ir-login__visual" aria-labelledby="ir-login-visual-title">
          <div className="ir-login__visual-frame">
            <img className="ir-login__portrait" src={annaPortrait} alt="Anna" />
            <div className="ir-login__brand">
              <span id="ir-login-visual-title" className="ir-login__brand-name">Anna</span>
              <span className="ir-login__brand-meta">CREW</span>
            </div>
          </div>
          <div className="ir-login__visual-note">
            <span className="ir-login__caption">与你的 Crew 一起工作</span>
            <span className="ir-login__visual-index">01 / ANNA</span>
          </div>
        </section>

        <form className="ir-login__form-card" onSubmit={submit}>
          <div className="ir-login__eyebrow">
            <span>ANNA / CREW</span>
            <span>登录入口</span>
          </div>
          <h1 className="ir-login__title">欢迎回来。</h1>
          <p className="ir-login__sub">使用你的 Crew 账户继续</p>

          <div className="ir-login__form">
            <label className="ir-login__field" htmlFor="ir-login-email">
              <span className="ir-login__label">邮箱</span>
              <input
                id="ir-login-email"
                className="ir-login__input"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="ir-login__field" htmlFor="ir-login-password">
              <span className="ir-login__label">密码</span>
              <input
                id="ir-login-password"
                className="ir-login__input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>

            {error && <StateNote kind="error" text={error} />}

            <button
              type="submit"
              className="ir-login__submit"
              disabled={busy || !email.trim() || !password}
            >
              {busy ? "验证中……" : "登录"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default LoginPage;
