import { useNavigate } from 'react-router-dom'
import { useApp } from '../state'
import type { BaseItem } from '../api/types'

/** 海报卡片:自动决定点击后进详情(剧集)还是直接播(电影/单集) */
export default function PosterCard({ item, width = 160 }: { item: BaseItem; width?: number }) {
  const { api } = useApp()
  const navigate = useNavigate()

  // uhd 交互:点卡片一律进详情页,在详情页选版本/集数后播放
  const target = `/item/${item.Id}`
  const img = item.ImageTags?.Primary
    ? api.imageUrl(item.Id, 'Primary', item.Type === 'Episode' ? width * 2 : width * 2)
    : ''
  const isEpisode = item.Type === 'Episode'

  const pos = item.UserData?.PlaybackPositionTicks ?? 0
  const runtime = item.RunTimeTicks ?? 0
  const pct = runtime > 0 && pos > 0 ? Math.min(100, (pos / runtime) * 100) : 0
  const epTitle = item.SeriesName
    ? `S${item.ParentIndexNumber ?? '?'}E${item.IndexNumber ?? '?'} ${item.Name}`
    : item.Name

  // 分集用横版剧照卡(16:9),剧集/电影用竖版海报卡(2:3)
  if (isEpisode) {
    return (
      <div className="episode-card" style={{ width }} onClick={() => navigate(target)}>
        <div className="episode-thumb">
          {img ? <img loading="lazy" src={img} alt={item.Name} /> : <div className="poster-fallback">{item.Name}</div>}
          <div className="poster-hover"><span className="poster-hover-play">▶</span></div>
          {item.UserData?.Played && <span className="badge-watched">已看</span>}
          <span className="episode-badge">{item.ParentIndexNumber === 0 ? '特别篇' : `第 ${item.IndexNumber ?? '?'} 集`}</span>
          {pct > 0 && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <div className="episode-title" title={epTitle}>{epTitle}</div>
      </div>
    )
  }

  return (
    <div className="poster-card" style={{ width }} onClick={() => navigate(target)}>
      <div className="poster-box">
        {img ? <img loading="lazy" src={img} alt={item.Name} /> : (
          <div className="poster-fallback gradient">
            <span className="fallback-char">{item.Name.slice(0, 1)}</span>
            <span className="fallback-name">{item.Name.slice(0, 10)}</span>
          </div>
        )}
        <div className="poster-hover"><span className="poster-hover-play">▶</span></div>
        {item.CommunityRating ? <span className="badge-rating">★ {item.CommunityRating.toFixed(1)}</span> : null}
        {item.UserData?.Played && <span className="badge-watched">已看</span>}
        {pct > 0 && (
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="poster-title" title={item.Name}>{item.Name}</div>
      <div className="poster-sub">
        {[item.ProductionYear ?? '', item.OfficialRating ?? ''].filter(Boolean).join(' · ')}
      </div>
    </div>
  )
}
