import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useApp } from '../state'
import type { BaseItem } from '../api/types'

/** UHD 风格顶栏:Logo + 媒体库胶囊导航 + 搜索 + 用户 */
export default function Header() {
  const { auth, api, signOut } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const [term, setTerm] = useState('')
  const [views, setViews] = useState<BaseItem[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [accent, setAccent] = useState(() => localStorage.getItem('ewp/accent') ?? 'pink')

  const applyAccent = (key: string) => {
    document.body.dataset.accent = key
    localStorage.setItem('ewp/accent', key)
    setAccent(key)
  }

  useEffect(() => {
    api.views().then(setViews).catch(() => {})
  }, [api])

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (term.trim()) navigate(`/library/search?q=${encodeURIComponent(term.trim())}`)
  }

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)

  return (
    <header className="app-header" onClick={() => setSettingsOpen(false)}>
      <span className="logo" onClick={() => navigate('/')}>
        <img src="/stream/logo-heimao.png" alt="heimaoのemby" style={{ height: '34px', borderRadius: '6px' }} />
      </span>

      <nav className="nav-pills">
        <button className={`nav-pill ${isActive('/') ? 'active' : ''}`} onClick={() => navigate('/')}>首页</button>
        {views.map((v) => (
          <button
            key={v.Id}
            className={`nav-pill ${isActive(`/library/${v.Id}`) ? 'active' : ''}`}
            onClick={() => navigate(`/library/${v.Id}`)}
          >
            {v.Name}
          </button>
        ))}
      </nav>

      <div className="header-right">
        {searchOpen ? (
          <form className="header-search" onSubmit={doSearch}>
            <input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onBlur={() => !term && setSearchOpen(false)}
              placeholder="搜索电影、剧集…"
            />
          </form>
        ) : (
          <button className="icon-btn" onClick={() => setSearchOpen(true)} title="搜索">🔍</button>
        )}
        <div className="settings-box">
          <button className="icon-btn" title="界面设置" onClick={(e) => { e.stopPropagation(); setSettingsOpen(!settingsOpen) }}>⚙</button>
          {settingsOpen && (
            <div className="settings-pop" onClick={(e) => e.stopPropagation()}>
              <h4>主题色</h4>
              <div className="theme-swatches">
                {([
                  ['pink', '#ff4d94'], ['emerald', '#10b981'], ['blue', '#3b82f6'],
                  ['violet', '#8b5cf6'], ['orange', '#f97316'], ['cyan', '#06b6d4'],
                ] as [string, string][]).map(([key, color]) => (
                  <button
                    key={key}
                    className={`theme-swatch ${accent === key ? 'active' : ''}`}
                    onClick={() => applyAccent(key)}
                    title={key}
                  >
                    <span style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <span className="avatar" title={auth?.userName}>{(auth?.userName ?? '?').slice(0, 1).toUpperCase()}</span>
        <button
          className="btn-ghost"
          onClick={async () => {
            await api.logout().catch(() => {})
            signOut()
            navigate('/login')
          }}
        >
          退出
        </button>
      </div>
    </header>
  )
}
