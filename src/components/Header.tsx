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
    <header className="app-header">
      <span className="logo" onClick={() => navigate('/')}>
        <img src="/stream/logo-wordmark.png" alt="动漫一生推" className="logo-img" />
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
            <span className="search-ico">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onBlur={() => !term && setSearchOpen(false)}
              placeholder="搜索影片…"
            />
          </form>
        ) : (
          <button className="icon-btn" onClick={() => setSearchOpen(true)} title="搜索" aria-label="搜索">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
        )}
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
