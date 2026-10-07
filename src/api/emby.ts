import type { AuthResult, BaseItem, PlaybackInfoResponse, QueryParams } from './types'

export interface AuthInfo {
  server: string // 形如 http://192.168.1.10:8096,不带 /emby 后缀
  token: string
  userId: string
  userName: string
  deviceId: string
}

const AUTH_KEY = 'emby-web-player/auth'
const DEVICE_KEY = 'emby-web-player/deviceId'

export function loadAuth(): AuthInfo | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY)
    return raw ? (JSON.parse(raw) as AuthInfo) : null
  } catch {
    return null
  }
}

export function saveAuth(info: AuthInfo | null) {
  if (info) localStorage.setItem(AUTH_KEY, JSON.stringify(info))
  else localStorage.removeItem(AUTH_KEY)
}

function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

/** 用户输入的服务器地址做归一化:去尾部斜杠和已有的 /emby 后缀 */
export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, '')
  if (/\/emby$/i.test(s)) s = s.slice(0, -5)
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  return s
}


export class EmbyApi {
  constructor(
    private getAuth: () => AuthInfo | null,
    private onUnauthorized: () => void,
  ) {}

  /** 克隆一个把服务器基址换成备用线路的实例(共用同一份登录态) */
  withServer(server: string): EmbyApi {
    return new EmbyApi(
      () => {
        const a = this.getAuth()
        return a ? { ...a, server: normalizeServer(server) } : a
      },
      this.onUnauthorized,
    )
  }

  private mustAuth(): AuthInfo {
    const a = this.getAuth()
    if (!a) throw new Error('未登录')
    return a
  }

  private authHeader(token?: string): string {
    const a = this.getAuth()
    const deviceId = a?.deviceId ?? getOrCreateDeviceId()
    const tokenPart = token ?? a?.token ?? ''
    return (
      `MediaBrowser Client="Emby Web Player", Device="Web", DeviceId="${deviceId}", ` +
      `Version="0.1.0"${tokenPart ? `, Token="${tokenPart}"` : ''}`
    )
  }

  /** 拼接带鉴权的接口 URL(图片等公开资源也可用) */
  url(path: string, params?: QueryParams): string {
    const base = this.mustAuth().server
    const u = new URL(base + (path.startsWith('/') ? path : '/' + path))
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
      }
    }
    return u.toString()
  }

  private async request<T>(
    path: string,
    opts: { method?: string; params?: QueryParams; body?: unknown } = {},
  ): Promise<T> {
    const auth = this.mustAuth()
    const res = await fetch(this.url(path, opts.params), {
      method: opts.method ?? 'GET',
      headers: {
        'X-Emby-Token': auth.token,
        'X-Emby-Authorization': this.authHeader(),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    if (res.status === 401) {
      this.onUnauthorized()
      throw new Error('登录已过期,请重新登录')
    }
    if (!res.ok) throw new Error(`请求失败 ${res.status}: ${res.statusText}`)
    const ct = res.headers.get('content-type') ?? ''
    return (ct.includes('json') ? await res.json() : await res.text()) as T
  }

  // ---------- 登录 / 会话 ----------

  async login(serverRaw: string, username: string, password: string, totp = ''): Promise<AuthInfo> {
    // 2FA 插件惯例:动态验证码以冒号拼接在密码后
    const pw = totp ? `${password}:${totp}` : password
    const server = normalizeServer(serverRaw)
    const deviceId = getOrCreateDeviceId()
    let res: Response
    try {
      res = await fetch(`${server}/emby/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 登录请求还没有 token,只带客户端声明
          'X-Emby-Authorization': this.authHeader(undefined),
        },
        body: JSON.stringify({ Username: username, Pw: pw }),
      })
    } catch {
      throw new Error('无法连接到服务器,请检查地址是否正确、服务是否在线')
    }
    if (!res.ok) {
      if (res.status === 401) throw new Error('用户名或密码错误')
      throw new Error(`登录失败 ${res.status}: ${res.statusText}(请检查服务器地址)`)
    }
    const data = (await res.json()) as AuthResult
    return {
      server,
      token: data.AccessToken,
      userId: data.User.Id,
      userName: data.User.Name,
      deviceId,
    }
  }

  async logout() {
    try {
      await this.request('/emby/Sessions/Logout', { method: 'POST' })
    } catch {
      // 服务端登出失败无所谓,本地清掉即可
    }
  }

  // ---------- 媒体库浏览 ----------

  async views(): Promise<BaseItem[]> {
    const uid = this.mustAuth().userId
    const r = await this.request<{ Items: BaseItem[] }>(`/emby/Users/${uid}/Views`)
    return r.Items ?? []
  }

  async resumeItems(limit = 12): Promise<BaseItem[]> {
    const uid = this.mustAuth().userId
    const r = await this.request<{ Items: BaseItem[] }>(`/emby/Users/${uid}/Items/Resume`, {
      params: { Limit: limit, MediaTypes: 'Video', Fields: 'PrimaryImageAspectRatio,BasicSyncInfo' },
    })
    return r.Items ?? []
  }

  async latestItems(limit = 18): Promise<BaseItem[]> {
    const uid = this.mustAuth().userId
    return this.request<BaseItem[]>(`/emby/Users/${uid}/Items/Latest`, {
      // 剧集/电影两级:按分集展示会一剧刷屏,且分集缩略图是 16:9 不适配海报框
      params: { Limit: limit, IncludeItemTypes: 'Series,Movie', Fields: 'PrimaryImageAspectRatio', ImageTypeLimit: 1 },
    })
  }

  async libraryItems(
    parentId: string,
    startIndex: number,
    limit: number,
    searchTerm?: string,
    sort: 'latest' | 'name' | 'random' = 'latest',
  ): Promise<{ Items: BaseItem[]; TotalRecordCount: number }> {
    const uid = this.mustAuth().userId
    const r = await this.request<{ Items: BaseItem[]; TotalRecordCount: number }>(
      `/emby/Users/${uid}/Items`,
      {
        params: {
          // 搜索时不带 ParentId(从全库找),浏览时限定在当前库
          ParentId: searchTerm ? undefined : parentId,
          // 搜索只出剧集/电影两级,分集进详情页里选(全库搜分集会刷屏)
          // 浏览/搜索都只出剧集和电影两级:分集平铺会把整个库拆成文件名卡片
          IncludeItemTypes: 'Movie,Series',
          Recursive: true,
          SearchTerm: searchTerm,
          // 库浏览默认"最新入库优先",可切按名称/随机
          SortBy: sort === 'latest' ? 'DateCreated' : sort === 'random' ? 'Random' : 'SortName',
          SortOrder: sort === 'latest' ? 'Descending' : 'Ascending',
          Fields: 'PrimaryImageAspectRatio,ProductionYear,Overview',
          StartIndex: startIndex,
          Limit: limit,
          ImageTypeLimit: 1,
        },
      },
    )
    // Emby 搜索接口的 TotalRecordCount 会返回 0,兜底为当前页长度
    return { ...r, TotalRecordCount: r.TotalRecordCount || r.Items?.length || 0 }
  }

  /** 收藏夹(电影+剧集) */
  async favoriteItems(): Promise<BaseItem[]> {
    const uid = this.mustAuth().userId
    const r = await this.request<{ Items: BaseItem[] }>(`/emby/Users/${uid}/Items`, {
      params: {
        Filters: 'Favorites',
        IncludeItemTypes: 'Movie,Series',
        Recursive: true,
        Fields: 'PrimaryImageAspectRatio,ProductionYear',
        Limit: 200,
        ImageTypeLimit: 1,
      },
    })
    return r.Items ?? []
  }

  /** 切换收藏状态 */
  async setFavorite(itemId: string, fav: boolean): Promise<void> {
    const uid = this.mustAuth().userId
    await this.request(`/emby/Users/${uid}/Favorites/${itemId}`, {
      method: fav ? 'POST' : 'DELETE',
    })
  }

  /** 追新:最近入库的分集(按入库时间倒序) */
  async recentEpisodes(limit = 120): Promise<BaseItem[]> {
    const uid = this.mustAuth().userId
    const r = await this.request<{ Items: BaseItem[] }>(`/emby/Users/${uid}/Items`, {
      params: {
        IncludeItemTypes: 'Episode',
        Recursive: true,
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        Fields: 'PrimaryImageAspectRatio,ProductionYear',
        Limit: limit,
        ImageTypeLimit: 1,
      },
    })
    return r.Items ?? []
  }

  async item(id: string): Promise<BaseItem> {
    const uid = this.mustAuth().userId
    return this.request(`/emby/Users/${uid}/Items/${id}`, {
      params: { Fields: 'MediaSources,Genres,Overview,ProductionYear,OfficialRating' },
    })
  }

  async seasons(seriesId: string): Promise<BaseItem[]> {
    const uid = this.mustAuth().userId
    const r = await this.request<{ Items: BaseItem[] }>(`/emby/Shows/${seriesId}/Seasons`, {
      params: { UserId: uid, Fields: 'IndexNumber' },
    })
    return r.Items ?? []
  }

  /** 分集列表:Emby 4.9 的 /Shows/{id}/Episodes 要 SeriesId,SeasonId 用查询参数过滤(传 SeasonId 当路径段会 404) */
  async episodes(seriesId: string, seasonId?: string): Promise<BaseItem[]> {
    const uid = this.mustAuth().userId
    const r = await this.request<{ Items: BaseItem[] }>(`/emby/Shows/${seriesId}/Episodes`, {
      params: { UserId: uid, SeasonId: seasonId, Fields: 'PrimaryImageAspectRatio,Overview' },
    })
    return r.Items ?? []
  }

  // ---------- 播放 ----------

  async playbackInfo(
    itemId: string,
    deviceProfile: unknown,
    startTimeTicks = 0,
    forceTranscode = false,
  ): Promise<PlaybackInfoResponse> {
    const uid = this.mustAuth().userId
    return this.request(`/emby/Items/${itemId}/PlaybackInfo`, {
      method: 'POST',
      params: {
        UserId: uid,
        StartTimeTicks: startTimeTicks,
        IsPlayback: true,
        AutoOpenLiveStream: true,
        MaxStreamingBitrate: 140000000,
      },
      body: {
        DeviceProfile: deviceProfile,
        // 浏览器解码能力不足时打开转码通道,让服务器返回 TranscodingUrl
        EnableDirectPlay: !forceTranscode,
        EnableDirectStream: !forceTranscode,
        EnableTranscoding: true,
      },
    })
  }

  /** 视频/字幕直链(不带 token 头的场景用 api_key 查询参数) */
  mediaUrl(path: string, params?: QueryParams): string {
    const a = this.mustAuth()
    const p = { ...params, api_key: a.token }
    const u = new URL(a.server + (path.startsWith('/') ? path : '/' + path))
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  /** 带鉴权头抓取文本(字幕内容),避免 token 出现在 URL 里 */
  async fetchText(path: string, params?: QueryParams): Promise<string> {
    const auth = this.mustAuth()
    const res = await fetch(this.url(path, params), {
      headers: { 'X-Emby-Token': auth.token, 'X-Emby-Authorization': this.authHeader() },
    })
    if (!res.ok) throw new Error(`字幕加载失败 ${res.status}`)
    return res.text()
  }

  // ---------- 播放进度上报 ----------

  private sessionBody(extra: Record<string, unknown> = {}) {
    const a = this.mustAuth()
    return { UserId: a.userId, ...extra }
  }

  reportPlayingStart(body: Record<string, unknown>) {
    return this.request('/emby/Sessions/Playing', { method: 'POST', body: this.sessionBody(body) })
  }

  reportProgress(body: Record<string, unknown>) {
    return this.request('/emby/Sessions/Playing/Progress', {
      method: 'POST',
      body: this.sessionBody(body),
    })
  }

  reportStopped(body: Record<string, unknown>) {
    return this.request('/emby/Sessions/Playing/Stopped', {
      method: 'POST',
      body: this.sessionBody(body),
    })
  }

  markPlayed(itemId: string) {
    const uid = this.mustAuth().userId
    return this.request(`/emby/Users/${uid}/PlayedItems/${itemId}`, { method: 'POST' })
  }

  // ---------- 图片 ----------

  imageUrl(itemId: string, type: 'Primary' | 'Backdrop' | 'Thumb', maxWidth: number): string {
    try {
      return this.url(`/emby/Items/${itemId}/Images/${type}`, { maxWidth, quality: 80 })
    } catch {
      return ''
    }
  }
}
