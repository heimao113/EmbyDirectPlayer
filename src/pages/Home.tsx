import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../state'
import PosterCard from '../components/PosterCard'
import type { BaseItem } from '../api/types'

let apiRef: ReturnType<typeof useApp>['api'] | null = null
function apiImg(id: string, type: 'Primary' | 'Backdrop' | 'Thumb', w: number) {
  return apiRef?.imageUrl(id, type, w) ?? ''
}

function heroBackdrop(it: BaseItem): string {
  return (it.BackdropImageTags?.length ?? 0) > 0
    ? apiImg(it.Id, 'Backdrop', 1600)
    : it.ImageTags?.Primary
      ? apiImg(it.Id, 'Primary', 900)
      : ''
}

function fmtDur(ticks?: number): string {
  if (!ticks) return ''
  const total = Math.round(ticks / 10_000_000)
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`
}

function fmtRemain(posTicks?: number, totalTicks?: number): string {
  if (!posTicks || !totalTicks) return ''
  const left = Math.max(0, Math.round((totalTicks - posTicks) / 10_000_000))
  if (left < 60) return `${left}秒`
  const h = Math.floor(left / 3600)
  const m = Math.round((left % 3600) / 60)
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`
}

interface ViewRow {
  view: BaseItem
  items: BaseItem[]
  total: number
}

/** UHD 风格首页:Hero 轮播 + 继续观看 + 各媒体库海报行(自己的库) */
export default function Home() {
  const { api } = useApp()
  apiRef = api
  const navigate = useNavigate()
  const [resume, setResume] = useState<BaseItem[]>([])
  const [latest, setLatest] = useState<BaseItem[]>([])
  const [views, setViews] = useState<BaseItem[]>([])
  const [viewRows, setViewRows] = useState<ViewRow[]>([])
  const [error, setError] = useState('')
  const [heroIdx, setHeroIdx] = useState(0)
  const [heroes, setHeroes] = useState<BaseItem[]>([])

  useEffect(() => {
    Promise.all([api.resumeItems(), api.latestItems(), api.views()])
      .then(async ([r, l, v]) => {
        setResume(r)
        setLatest(l)
        setViews(v)
        // 推荐位:从「动漫推荐」库随机抽几部(有图的),没有该库时退回 最新+继续观看
        let pool: BaseItem[] = []
        const recView = v.find((x) => (x.Name ?? '').includes('推荐'))
        if (recView) {
          try {
            const r2 = await api.libraryItems(recView.Id, 0, 40, undefined, 'random')
            pool = r2.Items.filter(
              (it) => it.ImageTags?.Primary || (it.BackdropImageTags?.length ?? 0) > 0,
            )
          } catch {
            /* 拉取失败走兜底 */
          }
        }
        setHeroes(
          pool.length > 0
            ? pool.slice(0, 5)
            : [...r.slice(0, 2), ...l.slice(0, 5)].slice(0, 5),
        )
        const rows = await Promise.all(
          v.map(async (view): Promise<ViewRow> => {
            try {
              const r2 = await api.libraryItems(view.Id, 0, 12, undefined, 'latest')
              return { view, items: r2.Items, total: r2.TotalRecordCount }
            } catch {
              return { view, items: [], total: 0 }
            }
          }),
        )
        setViewRows(rows.filter((x) => x.items.length > 0))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [api])

  useEffect(() => {
    if (heroes.length < 2) return
    const t = setInterval(() => setHeroIdx((i) => (i + 1) % heroes.length), 8000)
    return () => clearInterval(t)
  }, [heroes.length])

  if (error) return <div className="page-error">加载失败:{error}</div>

  const hero = heroes[heroIdx]
  const heroImg = hero ? heroBackdrop(hero) : ''
  const heroTitle = hero
    ? hero.Type === 'Episode' && hero.SeriesName
      ? hero.SeriesName
      : hero.Name
    : ''
  const heroMeta = [
    hero?.ProductionYear ?? '',
    ...(hero?.Genres?.slice(0, 2) ?? []),
    hero?.CommunityRating ? `★ ${hero.CommunityRating.toFixed(1)}` : '',
  ].filter(Boolean)
  const heroAction = hero ? `/item/${hero.Id}` : ''

  return (
    <div className="home-page">
      {hero && (
        <div className="hero">
          {heroImg && <div className="hero-bg" style={{ backgroundImage: `url(${heroImg})` }} />}
          <div className="hero-shade" />
          <div className="hero-content">
            <h1 className="hero-title">{heroTitle}</h1>
            {heroMeta.length > 0 && (
              <div className="hero-meta">{heroMeta.map((m, i) => <span key={i}>{m}</span>)}</div>
            )}
            {hero.Overview && <p className="hero-overview">{hero.Overview}</p>}
            <div className="hero-actions">
              <button className="hero-cta" onClick={() => navigate(heroAction)}>▶ 播放</button>
              <button className="hero-sub" onClick={() => navigate(heroAction)}>详细</button>
            </div>
          </div>
          {heroes.length > 1 && (
            <div className="hero-picker">
              {heroes.map((h, i) => (
                <button
                  key={h.Id}
                  className={`hero-thumb ${i === heroIdx ? 'active' : ''}`}
                  style={{
                    backgroundImage: `url(${
                      h.ImageTags?.Primary
                        ? api.imageUrl(h.Id, 'Primary', 120)
                        : (h.BackdropImageTags?.length ?? 0) > 0
                          ? apiImg(h.Id, 'Backdrop', 240)
                          : ''
                    })`,
                  }}
                  onClick={() => setHeroIdx(i)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {resume.length > 0 && (
        <section>
          <h2>继续观看 <span className="count">{resume.length}</span></h2>
          <div className="poster-row">
            {resume.map((it) => {
              const img = it.ImageTags?.Primary
                ? api.imageUrl(it.Id, 'Primary', 560)
                : it.SeriesId
                  ? api.imageUrl(it.SeriesId, 'Primary', 560)
                  : ''
              const total = it.RunTimeTicks ?? 0
              const pos = it.UserData?.PlaybackPositionTicks ?? 0
              const pct = total > 0 ? Math.min(100, (pos / total) * 100) : 0
              const remain = fmtRemain(pos, total)
              const title = it.Type === 'Episode' && it.SeriesName ? it.SeriesName : it.Name
              const sub =
                it.Type === 'Episode'
                  ? `S${it.ParentIndexNumber ?? '?'}E${it.IndexNumber ?? '?'} ${it.Name}`
                  : [it.ProductionYear ?? '', it.Type === 'Movie' ? '电影' : ''].filter(Boolean).join(' · ')
              return (
                <div key={it.Id} className="resume-card" onClick={() => navigate(`/play/${it.Id}`)}>
                  <div className="resume-thumb">
                    {img ? <img loading="lazy" src={img} alt={it.Name} /> : <div className="poster-fallback gradient"><span className="fallback-char">{(it.SeriesName ?? it.Name).slice(0, 1)}</span></div>}
                    <span className="resume-play">▶</span>
                    {remain && <span className="resume-remain">剩 {remain}</span>}
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <div className="resume-title" title={title}>{title}</div>
                  <div className="resume-sub">
                    {sub}
                    {pct > 0 && <span className="resume-pct"> · 已看 {Math.round(pct)}%</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {viewRows.map((row) => (
        <section key={row.view.Id}>
          <h2>
            {row.view.Name} <span className="count">{row.total}</span>
            <button className="see-all" onClick={() => navigate(`/library/${row.view.Id}`)}>查看全部 ›</button>
          </h2>
          <div className="poster-row">
            {row.items.map((it) => (
              <PosterCard key={it.Id} item={it} width={150} />
            ))}
          </div>
        </section>
      ))}

    </div>
  )
}
