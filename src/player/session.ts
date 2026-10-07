/**
 * 播放会话(uhd 式):详情页选好版本/线路后生成 UUID 会话,
 * 播放页按会话播放。存 sessionStorage,6 小时过期。
 */
export interface PlaySession {
  itemId: string
  /** direct=原画直连;transcode=服务器转码 */
  mode: 'direct' | 'transcode'
  /** 备用反代线路完整地址;不填走主站 */
  srv?: string
  created: number
}

const PREFIX = 'ewp/playsession:'
const TTL = 6 * 3600 * 1000

export function createPlaySession(sess: Omit<PlaySession, 'created'>): string {
  // 顺手清理过期会话
  const now = Date.now()
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const k = sessionStorage.key(i)
    if (k?.startsWith(PREFIX)) {
      try {
        const v = JSON.parse(sessionStorage.getItem(k) ?? '{}') as PlaySession
        if (!v.created || now - v.created > TTL) sessionStorage.removeItem(k)
      } catch {
        sessionStorage.removeItem(k)
      }
    }
  }
  const id = crypto.randomUUID()
  sessionStorage.setItem(PREFIX + id, JSON.stringify({ ...sess, created: now }))
  return id
}

export function loadPlaySession(id: string): PlaySession | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + id)
    if (!raw) return null
    const sess = JSON.parse(raw) as PlaySession
    if (!sess.created || Date.now() - sess.created > TTL) {
      sessionStorage.removeItem(PREFIX + id)
      return null
    }
    return sess
  } catch {
    return null
  }
}
