import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../state'
import { REGISTER_URL } from '../config'

export default function Login() {
  const { auth, api, signIn } = useApp()
  const navigate = useNavigate()
  // 服务器地址:同域部署默认当前站点;保存过其他地址则优先(隐藏输入框,高级场景可改 localStorage)
  const [server] = useState(() => localStorage.getItem('emby-web-player/lastServer') ?? location.origin)
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
      const info = await api.login(server, username.trim(), password)
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
          <div className="login-brand">
            <img src="/stream/brand-cat.png" alt="动漫一生推" className="login-brand-img" />
          </div>
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
          {error && <div className="lc-error">{error}</div>}
          <button className="lc-submit" disabled={busy || !username || !password}>
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
