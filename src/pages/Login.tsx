import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../state'

/** 注册地址:自己的注册页,改这里即可 */
const REGISTER_URL = 'https://yh.heimao.dpdns.org/'
/** 找回密码:Emby 官方找回流程 */
const forgotUrl = (server: string) => `${server}/emby/web/index.html#!/startup/forgotpassword.html`

export default function Login() {
  const { auth, api, signIn } = useApp()
  const navigate = useNavigate()
  // 服务器地址:同域部署默认当前站点;保存过其他地址则优先(隐藏输入框,高级场景可改 localStorage)
  const [server] = useState(() => localStorage.getItem('emby-web-player/lastServer') ?? location.origin)
  const [totp, setTotp] = useState('')
  const [totpEnabled, setTotpEnabled] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (auth) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const info = await api.login(server, username.trim(), password, totpEnabled ? totp.trim() : '')
      localStorage.setItem('emby-web-player/lastServer', info.server)
      signIn(info)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-bg" aria-hidden />
      <div className="login-shade" aria-hidden />
      <div className="login-layout">
        <div className="login-hero">
          <img src="/logo-heimao.png" alt="heimaoのemby" style={{ width: 'clamp(280px, 50vw, 480px)', borderRadius: '12px' }} />
        </div>
        <form className="login-card" onSubmit={submit}>
          <div className="lc-field">
            <label className="lc-label" htmlFor="lc-user">用户名</label>
            <input
              id="lc-user"
              className="lc-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="lc-field">
            <label className="lc-label" htmlFor="lc-pass">密码</label>
            <input
              id="lc-pass"
              className="lc-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="lc-field">
            <div className="lc-label-row">
              <label className="lc-label" htmlFor="lc-totp">动态验证码</label>
              <button type="button" className="lc-hint-btn" onClick={() => setTotpEnabled((v) => !v)}>
                {totpEnabled ? '不使用' : '启用后填写'}
              </button>
            </div>
            <input
              id="lc-totp"
              className={`lc-input ${totpEnabled ? '' : 'lc-input-dim'}`}
              value={totpEnabled ? totp : ''}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="6 位验证码"
              disabled={!totpEnabled}
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </div>
          {error && <div className="lc-error">{error}</div>}
          <div className="lc-forgot-row">
            <span />
            <a className="lc-link" href={forgotUrl(server)} target="_blank" rel="noreferrer">找回密码</a>
          </div>
          <button className="lc-submit" disabled={busy || !username || !password || (totpEnabled && !totp)}>
            {busy ? '登录中…' : '登录'}
          </button>
          <div className="lc-register">
            还没有账号?{' '}
            <a className="lc-link lc-link-strong" href={REGISTER_URL} target="_blank" rel="noreferrer">
              立即注册
            </a>
          </div>
        </form>
      </div>
    </div>
  )
}
