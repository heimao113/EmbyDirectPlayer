import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../state'
import { createPlaySession } from '../player/session'
import { buildDeviceProfile, detectAc3Support } from '../player/deviceProfile'
import { normalizeServer } from '../api/emby'
import { MIRROR_SERVER } from '../config'
import type { BaseItem } from '../api/types'

function fmtTicks(ticks?: number): string {
  if (!ticks) return '0:00'
  const total = Math.round(ticks / 10_000_000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export default function Detail() {
  const { id } = useParams<{ id: string }>()
  const { api } = useApp()
  const navigate = useNavigate()
  const [item, setItem] = useState<BaseItem | null>(null)
  const [seasons, setSeasons] = useState<BaseItem[]>([])
  const [seasonId, setSeasonId] = useState<string | null>(null)
  const [episodes, setEpisodes] = useState<BaseItem[]>([])
  const [asc, setAsc] = useState(true)
  const [error, setError] = useState('')

  // 直接开播(去掉选版本弹窗):剧集解析第一集,srv 传入备用反代线路
  const startPlay = async (srv?: string) => {
    if (!item) return
    let target = item
    if (item.Type === 'Series') {
      const s1 = seasons.find((s) => s.IndexNumber === 1) ?? seasons[0]
      if (!s1) return
      const eps = await api.episodes(item.Id, s1.Id).catch(() => [])
      const first = eps.find((e) => !e.UserData?.Played) ?? eps[0]
      if (!first) return
      target = first
    }
    const sid = createPlaySession({ itemId: target.Id, mode: 'direct', srv: srv ? normalizeServer(srv) : undefined })
    navigate(`/play/${target.Id}?session=${sid}`)
  }
  const playLabel = item
    ? item.Type === 'Series'
      ? '立即播放'
      : (item.UserData?.PlaybackPositionTicks ?? 0) > 0
        ? `继续播放 ${Math.round(((item.UserData?.PlaybackPositionTicks ?? 0) / (item.RunTimeTicks || 1)) * 100)}%`
        : '立即播放'
    : '立即播放'


  useEffect(() => {
    if (!id) return
    setItem(null)
    api
      .item(id)
      .then(async (it) => {
        setItem(it)
        if (it.Type === 'Series') {
          const ss = await api.seasons(it.Id)
          setSeasons(ss)
          // 默认选第 1 季正片(uhd 行为),没有正片再选第一个
          const s1 = ss.find((x) => x.IndexNumber === 1) ?? ss[0]
          if (s1) setSeasonId(s1.Id)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [api, id])

  useEffect(() => {
    if (!seasonId) {
      setEpisodes([])
      return
    }
    // episodes 需要 SeriesId(路径)+ SeasonId(过滤),剧集详情页两者都有
    if (item?.Type === 'Series' && item.Id) {
      api.episodes(item.Id, seasonId).then(setEpisodes).catch(() => setEpisodes([]))
    }
  }, [api, seasonId, item])

  if (error) return <div className="page-error">加载失败:{error}</div>
  if (!item) return <div className="page-loading">加载中…</div>

  const isMovie = item.Type === 'Movie'
  const meta = [
    item.CommunityRating ? `★ ${item.CommunityRating.toFixed(1)}` : '',
    item.ProductionYear ?? '',
    item.Type === 'Series' && seasons.length > 0 ? `${seasons.length} 季` : '',
    item.OfficialRating ?? '',
    ...(item.Genres?.slice(0, 3) ?? []),
  ].filter(Boolean)

  return (
    <div className="detail-page">
      <div
        className="detail-backdrop"
        style={{
          backgroundImage:
            (item.BackdropImageTags?.length ?? 0) > 0 || item.ImageTags?.Primary
              ? `url(${api.imageUrl(item.Id, item.BackdropImageTags?.length ? 'Backdrop' : 'Primary', 1600)})`
              : undefined,
        }}
      />
      <div className="detail-body">
        <div className="detail-info">
          {item.ImageTags?.Primary && (
            <img className="detail-poster" src={api.imageUrl(item.Id, 'Primary', 400)} alt={item.Name} />
          )}
          <div className="detail-text">
            <span className="detail-type-badge">{item.Type === 'Series' ? '剧集' : item.Type === 'Movie' ? '电影' : '视频'}</span>
            <h1>{item.Name}</h1>
            {item.OriginalTitle && item.OriginalTitle !== item.Name && (
              <div className="detail-origtitle">{item.OriginalTitle}</div>
            )}
            <div className="detail-badges">
              {meta.map((m, i) => <span key={i} className={i === 0 && String(m).startsWith('★') ? 'badge-rate' : ''}>{m}</span>)}
            </div>
            {item.Overview && <p className="detail-overview">{item.Overview}</p>}
            {(isMovie || item.Type === 'Episode' || item.Type === 'Video' || item.Type === 'Series') && (
              <div className="detail-actions-wrap">
                <div className="detail-actions">
                  <button className="cta-primary" onClick={() => { void startPlay() }}>
                    ▶ {playLabel}
                  </button>
                  <button className="cta-ghost">♡ 加入收藏</button>
                </div>
                <button className="cta-line2" onClick={() => { void startPlay(MIRROR_SERVER) }} title={`经 ${MIRROR_SERVER} 反代播放`}>
                  ⇄ {playLabel} · 备用线路
                </button>
              </div>
            )}
          </div>
        </div>

        {item.Type === 'Series' && (
          <div className="episodes">
            <h2 className="episodes-title">剧集列表 <span className="count">{seasons.length} 季</span></h2>
            <div className="season-tabs">
              {seasons.map((s) => (
                <button
                  key={s.Id}
                  className={`season-tab ${s.Id === seasonId ? 'active' : ''}`}
                  onClick={() => setSeasonId(s.Id)}
                >
                  {s.Name}
                </button>
              ))}
              <span className="spacer" />
              <button className="order-toggle" onClick={() => setAsc(!asc)}>{asc ? '正序' : '倒序'}</button>
            </div>
            <div className="episode-list">
              {(asc ? episodes : [...episodes].reverse()).map((ep) => {
                const epPos = ep.UserData?.PlaybackPositionTicks ?? 0
                const pct = ep.RunTimeTicks ? Math.min(100, (epPos / ep.RunTimeTicks) * 100) : 0
                return (
                  <div key={ep.Id} className="episode-row" onClick={() => navigate(`/play/${ep.Id}`)}>
                    {ep.ImageTags?.Primary && (
                      <img className="ep-thumb" src={api.imageUrl(ep.Id, 'Primary', 320)} loading="lazy" alt="" />
                    )}
                    <div className="ep-info">
                      <span className="ep-name">{ep.Name}</span>
                      <span className="ep-sub">{fmtTicks(ep.RunTimeTicks)}{epPos > 0 ? ` · 看到 ${Math.round(pct)}%` : ''}</span>
                      {pct > 0 && (
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
