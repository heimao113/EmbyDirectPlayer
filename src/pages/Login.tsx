import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useApp } from '../state'

export default function Login() {
  const { auth, api, signIn } = useApp()
  const navigate = useNavigate()
  const [server, setServer] = useState(() => localStorage.getItem('emby-web-player/lastServer') ?? '')
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
      <form className="login-card" onSubmit={submit}>
        <h1>Emby 直连播放器</h1>
        <p className="login-hint">视频直连播放、字幕前端渲染,服务器不转码</p>
        <label>
          服务器地址
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="http://192.168.1.10:8096"
            autoComplete="url"
          />
        </label>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="btn-primary" disabled={busy || !server || !username}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
