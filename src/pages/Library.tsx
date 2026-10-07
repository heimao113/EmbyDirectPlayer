import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useApp } from '../state'
import PosterCard from '../components/PosterCard'
import type { BaseItem } from '../api/types'

const PAGE_SIZE = 60

export default function Library() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const searchTerm = params.get('q') ?? undefined
  const { api } = useApp()

  const [items, setItems] = useState<BaseItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [sort, setSort] = useState<'latest' | 'name'>('latest')

  const load = useCallback(
    async (startIndex: number, replace: boolean) => {
      if (!id && !searchTerm) return
      setLoading(true)
      try {
        const parentId = searchTerm ? undefined : id
        const r = await api.libraryItems(parentId ?? '', startIndex, PAGE_SIZE, searchTerm, sort)
        setItems((prev) => (replace ? r.Items : [...prev, ...r.Items]))
        setTotal(r.TotalRecordCount)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [api, id, searchTerm, sort],
  )

  useEffect(() => {
    setItems([])
    load(0, true)
  }, [load])

  const title = searchTerm ? `搜索“${searchTerm}”` : '媒体库'

  return (
    <div className="library-page">
      <div className="library-head">
        <h2>
          {title}
          {total > 0 && <span className="count">({total})</span>}
        </h2>
        {!searchTerm && (
          <div className="order-toggle-group">
            <button
              className={`order-toggle ${sort === 'latest' ? 'active' : ''}`}
              onClick={() => setSort('latest')}
            >
              最新
            </button>
            <button
              className={`order-toggle ${sort === 'name' ? 'active' : ''}`}
              onClick={() => setSort('name')}
            >
              名称
            </button>
          </div>
        )}
      </div>
      {error && <div className="page-error">加载失败:{error}</div>}
      <div className="poster-grid">
        {items.map((it) => (
          <PosterCard key={it.Id} item={it} width={160} />
        ))}
      </div>
      {items.length < total && (
        <div className="load-more">
          <button className="btn-ghost" disabled={loading} onClick={() => load(items.length, false)}>
            {loading ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  )
}
