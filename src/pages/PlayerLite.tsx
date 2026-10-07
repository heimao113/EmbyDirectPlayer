/**
 * 官方文档复刻版播放页(libmedia AVPlayer 标准集成)。
 *
 * 按 https://zhaohappy.github.io/libmedia/docs 的官方用法实现:
 * - AVPlayer 构造:container + getWasm(官方示例同款 codecId 映射,自托管 wasm)
 * - load(url, LoadOptions):ext / maxProbeDuration / ioLoaderOptions(preload、重试)
 *   / externalSubtitles(官方外挂字幕接口,Emby 提取的字幕以 File 装载)
 * - 生命周期事件:LOADED → 续播定位 + play;PAUSED/PLAYED;ENDED → 看完 + 下一集
 * - MSE → WebCodecs 硬解 → WASM 软解 的降级为 libmedia 内部官方行为
 * - 内嵌字幕由 libmedia 内置渲染器绘制(MKV 内嵌字体官方内部处理)
 *
 * Emby 胶水(保留):直连决策(含 TrueHD 音频兜底 remux)、续播、进度上报、下一集。
 * 适配层(保留):AAC 声道修复 + 音轨优选(findBestStream,纯 AVPlayer 完整透传该选项)、
 * 视频/音频停滞看门狗、键盘操作。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AVPlayer, { Events } from '@libmedia/avplayer'
import { AVCodecID } from '@libmedia/avutil/enum'
import { useApp } from '../state'
import type { BaseItem, MediaSource, MediaStream } from '../api/types'
import { buildDeviceProfile, isAudioLocallyDecodable, pickPreferredAudioIndex } from '../player/deviceProfile'
import { fetchSubtitleText, setBilingualStripPref, getBilingualStripPref, stripJapaneseEvents } from '../player/subtitles'

const WASM_BASE = new URL(import.meta.env.BASE_URL, location.href).href

/** 官方示例同款:getWasm 按 codecId 返回自托管解码器 */
function getWasm(type: 'decoder' | 'resampler' | 'stretchpitcher', codecId?: number): string {
  const v = 'simd'
  const d = `${WASM_BASE}wasm/decode/`
  if (type === 'decoder' && codecId !== undefined) {
    const map: Record<number, string> = {
      [AVCodecID.AV_CODEC_ID_AAC]: `${d}aac-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_MP3]: `${d}mp3-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_FLAC]: `${d}flac-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_AC3]: `${d}ac3-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_EAC3]: `${d}eac3-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_DTS]: `${d}dca-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_H264]: `${d}h264-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_HEVC]: `${d}hevc-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_AV1]: `${d}av1-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_VP8]: `${d}vp8-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_VP9]: `${d}vp9-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_MPEG2VIDEO]: `${d}mpeg2video-${v}.wasm`,
      [AVCodecID.AV_CODEC_ID_MPEG4]: `${d}mpeg4-${v}.wasm`,
    }
    if (map[codecId]) return map[codecId]
  }
  if (type === 'resampler') return `${WASM_BASE}wasm/resample/resample-${v}.wasm`
  if (type === 'stretchpitcher') return `${WASM_BASE}wasm/stretchpitch/stretchpitch-${v}.wasm`
  return `${d}aac-${v}.wasm`
}

/** 各声道数的标准布局掩码(ffmpeg av_channel_layout_default 同款) */
const CHANNEL_DEFAULT_MASK: Record<number, bigint> = {
  1: 0x4n, 2: 0x3n, 3: 0xBn, 4: 0x107n, 5: 0x37n, 6: 0x3Fn, 7: 0x70Fn, 8: 0x63Fn,
}

interface SrcInfo {
  url: string
  kind: 'direct' | 'direct-stream' | 'transcode'
  ext?: string
  audioTranscoded?: boolean
}

interface ExtSubInfo {
  index: number
  codec: string
  language?: string
  title?: string
  deliveryUrl?: string
}

export default function PlayerLite() {
  const navigate = useNavigate()
  const { id: itemId = '' } = useParams<{ id: string }>()
  const { api } = useApp()

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<AVPlayer | null>(null)
  const msRef = useRef<MediaSource | null>(null)
  const playSessionRef = useRef<string | undefined>(undefined)
  const pendingSeekRef = useRef(0)
  const startedRef = useRef(false)
  const pausedRef = useRef(false)
  const extSubsRef = useRef<ExtSubInfo[] | null>(null)
  const loadedExtKeyRef = useRef('')
  const audioStallRef = useRef(0)
  const audioReloadRef = useRef({ count: 0, lastAt: 0 })
  const hintRef = useRef<number | undefined>(undefined)
  const srcRef = useRef<SrcInfo | null>(null)
  const extSubsPRef = useRef<Promise<Array<{ source: File; lang?: string; title?: string }>> | null>(null)

  const [item, setItem] = useState<BaseItem | null>(null)
  const [src, setSrc] = useState<SrcInfo | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errText, setErrText] = useState('')
  const [stage, setStage] = useState('正在建立播放链路…')
  const [badge, setBadge] = useState('')
  // 控制栏状态
  const [paused, setPaused] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('ewp/volume') ?? 1) || 1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [subOn, setSubOn] = useState(true)
  const [showControls, setShowControls] = useState(true)
  const [openMenu, setOpenMenu] = useState<'audio' | 'speed' | null>(null)
  const [audioTracks, setAudioTracks] = useState<Array<{ id: number; label: string }>>([])
  const [selectedAudioId, setSelectedAudioId] = useState(-1)
  // 播放链路统计(打开后长久保活,seek/拖动不影响)
  const [diagOpen, setDiagOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [diag, setDiag] = useState<{
    container: string
    vCount: number
    aCount: number
    sCount: number
    vCodec: string
    width: number
    height: number
    fps: number
    aCodec: string
    aCh: number
    aDec: number
    aRen: number
    mbps: string
    vMbps: string
    aMbps: string
    pipeline: 'MSE' | 'WASM'
    dropped: number
    decodeLabel: string
  } | null>(null)
  // 进度条拖动状态:拖动中显示预览位置,提交后锁定直到播放追上(不回跳)
  const [seekDragging, setSeekDragging] = useState(false)
  const [seekPreview, setSeekPreview] = useState(0)
  const seekLockRef = useRef<{ target: number; until: number } | null>(null)
  const bitrateHistRef = useRef<number[]>([])
  const rxPrevRef = useRef<{ bytes: number; t: number } | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)

  const profile = useMemo(() => buildDeviceProfile(false), [])

  /** 整条切 remux(视频 -c copy 仅音频转 AAC);无可用链返回 false */
  const switchToRemux = useCallback(async (): Promise<boolean> => {
    let remux = (msRef.current?.DirectStreamUrl ?? msRef.current?.TranscodingUrl ?? '').trim()
    if (!remux) {
      const tr = await api.playbackInfo(itemId, profile, 0, true).catch(() => null)
      const ms2 = tr?.MediaSources?.[0]
      if (ms2) {
        msRef.current = ms2
        remux = (ms2.DirectStreamUrl ?? ms2.TranscodingUrl ?? '').trim()
      }
    }
    if (!remux) return false
    const url = remux.startsWith('http') ? new URL(remux).pathname + new URL(remux).search : remux
    const ext = (url.match(/\.(mkv|ts|m3u8|mp4)(?:$|\?)/i)?.[1] ?? 'mkv').toLowerCase()
    setSrc({ url, kind: 'direct-stream', ext, audioTranscoded: true })
    return true
  }, [api, itemId, profile])

  // ---------- 字幕准备:Emby 文本字幕 → 官方 externalSubtitles ----------
  const prepareExternalSubs = useCallback(async (): Promise<Array<{ source: File; lang?: string; title?: string }>> => {
    const ms = msRef.current
    if (!ms) return []
    const all = (ms.MediaStreams ?? []).filter((x) => x.Type === 'Subtitle')
    const text = all.filter((x) => !['pgs', 'pgssub', 'dvdsub', 'sup', 'dvbsub'].includes((x.Codec ?? '').toLowerCase()))
    if (text.length === 0) return []
    const strip = getBilingualStripPref()
    const pick = text.find((s) => s.IsDefault) ?? text.find((s) => (s.Language ?? '').toLowerCase().startsWith('zh')) ?? text[0]
    try {
      const raw = await fetchSubtitleText(
        api,
        { index: pick.Index, label: pick.DisplayTitle ?? '', codec: pick.Codec ?? '', isText: true, isGraphic: false, deliveryUrl: pick.DeliveryUrl },
        itemId,
        ms.Id,
      )
      // 双语偏好:开启时剥离日文行(持久化设置,字幕菜单可切换)
      const content = strip ? stripJapaneseEvents(raw) : raw
      const file = new File([content], `subtitle.${pick.Codec === 'subrip' ? 'srt' : pick.Codec}`, { type: 'text/plain' })
      const out = [{ source: file, lang: pick.Language ?? pick.Codec ?? '', title: pick.DisplayTitle ?? pick.Title ?? '字幕' }]
      console.info(`[subtitle] 外挂装载:轨 ${pick.Index} ${pick.Codec} ${Math.round(content.length / 1024)}KB`)
      return out
    } catch (e) {
      console.warn('[subtitle] 提取失败,无外挂字幕可装载', e)
      return []
    }
  }, [api, itemId])

  // ---------- 创建官方 AVPlayer(一次) ----------
  useEffect(() => {
    if (!surfaceRef.current || playerRef.current) return
    const player = new AVPlayer({
      container: surfaceRef.current,
      // 官方能力透传:纯 AVPlayer 完整支持 findBestStream(AVPlayerUI 不透传,故弃用)
      findBestStream: ((streams: Array<{ id?: number; index?: number }>, mediaType: number) => {
        console.info('[lite] findBestStream mediaType =', mediaType, 'streams =', streams.length)
        const proxies = (playerRef.current?.getStreams?.() ?? []) as unknown as Array<{
          id: number
          codecparProxy?: { codecType?: unknown; chLayout?: { order: unknown; nbChannels: number; u: { mask: bigint } } }
        }>
        const cpOf = (id?: number) => proxies.find((x) => x.id === id)?.codecparProxy
        const pool = streams.filter((s) => {
          const cp = cpOf(s.id)
          return cp ? Number(cp.codecType) === mediaType : false
        })
        if (mediaType === 1) {
          // AAC 5.1 声道修复:无效声道(-1)用 Emby 元数据真实值,UNSPEC 补标准掩码
          const hintCh = (msRef.current?.MediaStreams ?? []).find((x) => x.Type === 'Audio')?.Channels ?? 0
          for (const s of pool) {
            const cp = cpOf(s.id) as
              | { chLayout?: { order: unknown; nbChannels: number; u: { mask: bigint } } }
              | undefined
            const layout = cp?.chLayout
            if (!layout) continue
            const nb = Number(layout.nbChannels ?? 0)
            console.info('[lite] audio#', s.index, 'order', Number(layout.order), 'ch', nb, 'mask', String(layout.u?.mask ?? 0n))
            if (nb > 0 && Number(layout.order) === 0) {
              ;(layout as { order: unknown }).order = 1
              ;(layout.u as { mask: bigint }).mask = CHANNEL_DEFAULT_MASK[nb] ?? 0x3Fn
            } else if (nb <= 0 && hintCh > 0) {
              ;(layout as { nbChannels: unknown }).nbChannels = hintCh
              ;(layout as { order: unknown }).order = 1
              ;(layout.u as { mask: bigint }).mask = CHANNEL_DEFAULT_MASK[hintCh] ?? 0x3Fn
            }
          }
          if (hintRef.current !== undefined) {
            const hinted = pool.find((s) => s.index === hintRef.current)
            if (hinted) return hinted
          }
        }
        return pool[0]
      }) as never,
      enableWorker: globalThis.crossOriginIsolated === true,
    } as never)
    playerRef.current = player
    ;(window as unknown as Record<string, unknown>).__litePlayer = player
  }, [])

  // ---------- 生命周期事件绑定(一次) ----------
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    player.on(Events.LOADED, () => {
      startedRef.current = true
      setStatus('ready')
      setStage('')
      let seek = pendingSeekRef.current
      pendingSeekRef.current = 0
      try {
        // 二次校验:续播点超出片长(历史坏数据)→ 回到开头,播放后立即回写正确进度自愈
        const durMs = Number(player.getDuration())
        const durSec = durMs > 0 ? durMs / 1000 : 0
        if (durSec > 0 && seek > durSec - 5) seek = 0
      } catch { /* ignore */ }
      if (seek > 0) {
        void player.seek(BigInt(Math.round(seek * 1000))).catch(() => {})
      }
      void player.play().catch(() => {})
    })
    player.on(Events.PAUSED, () => { pausedRef.current = true; setPaused(true) })
    player.on(Events.PLAYED, () => { pausedRef.current = false; setPaused(false) })
    player.on(Events.TIME, () => {
      if (pausedRef.current) pausedRef.current = false
      try {
        const nowSec = Number(player.currentTime ?? 0) / 1000
        const lock = seekLockRef.current
        if (lock) {
          if (Math.abs(nowSec - lock.target) <= 2.5 || Date.now() > lock.until) seekLockRef.current = null
          else {
            // seek 追上之前,进度条与时间显示保持在目标位置(不回跳)
            setCur(lock.target)
            return
          }
        }
        setCur(nowSec)
        const d = player.getDuration()
        setDur(d > 0n ? Number(d) / 1000 : 0)
      } catch { /* ignore */ }
    })
    player.on(Events.ENDED, () => {
      void api.reportStopped({
        ItemId: itemId,
        MediaSourceId: msRef.current?.Id,
        PlaySessionId: playSessionRef.current,
        PositionTicks: 0,
      }).catch(() => {})
      void api.markPlayed(itemId).catch(() => {})
      void (async () => {
        if (!item || item.Type !== 'Episode' || !item.SeriesId || !item.SeasonId) return
        try {
          const eps = await api.episodes(item.SeriesId, item.SeasonId)
          const idx = eps.findIndex((x) => x.Id === item.Id)
          const next = eps.slice(idx + 1).find((x) => !x.UserData?.Played)
          if (next) navigate(`/play/${next.Id}`)
          else navigate(-1)
        } catch { navigate(-1) }
      })()
    })
  }, [api, itemId, item, navigate])

  // ---------- 初始化:媒体信息 + 播放决策 ----------
  useEffect(() => {
    let cancelled = false
    setBilingualStripPref(getBilingualStripPref())
    ;(async () => {
      try {
        const it = await api.item(itemId)
        if (cancelled) return
        setItem(it)
        const playable = ['Movie', 'Episode', 'Video', 'MusicVideo']
        if (!playable.includes(it.Type)) {
          navigate(`/item/${it.Id}`, { replace: true })
          return
        }
        const info = await api.playbackInfo(itemId, profile)
        if (cancelled) return
        playSessionRef.current = info.PlaySessionId
        const ms: MediaSource | undefined = info.MediaSources?.[0]
        if (!ms) {
          setStatus('error')
          setErrText('服务器没有返回可用的媒体源')
          return
        }
        msRef.current = ms
        // 字幕提取与视频加载并行:不阻塞起播,装载在 load 完成后进行
        extSubsPRef.current = prepareExternalSubs().catch(() => [])
        const container = (ms.Container ?? 'mp4').split(',')[0]
        const canDirect = ms.SupportsDirectPlay || ms.SupportsDirectStream
        const as: MediaStream | undefined = (ms.MediaStreams ?? []).find((x) => x.Type === 'Audio')

        const audioStreams = (ms.MediaStreams ?? []).filter((x) => x.Type === 'Audio')
        hintRef.current = pickPreferredAudioIndex(
          audioStreams.map((x) => ({ index: x.Index, codec: x.Codec, channels: x.Channels, isDefault: x.IsDefault })),
          false,
        )

        const audioLocal = isAudioLocallyDecodable(as?.Codec, false)
        const remuxUrl = (ms.DirectStreamUrl ?? ms.TranscodingUrl ?? '').trim()
        if (canDirect && !audioLocal && remuxUrl) {
          const url = remuxUrl.startsWith('http') ? new URL(remuxUrl).pathname + new URL(remuxUrl).search : remuxUrl
          const ext = (url.match(/\.(mkv|ts|m3u8|mp4)(?:$|\?)/i)?.[1] ?? 'mkv').toLowerCase()
          setBadge('直连视频 · 音频转码')
          setSrc({ url, kind: 'direct-stream', ext, audioTranscoded: true })
          return
        }

        if (canDirect) {
          const pos = (it.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000
          pendingSeekRef.current = pos > 30 ? pos - 0.75 : 0
          setBadge('直连')
          setSrc({
            url: api.mediaUrl(`/emby/Videos/${itemId}/stream.${container}`, {
              Static: true,
              MediaSourceId: ms.Id,
              PlaySessionId: info.PlaySessionId ?? '',
            }),
            kind: 'direct',
            ext: container,
          })
        } else {
          const tUrl = ms.TranscodingUrl ?? ''
          if (!tUrl) {
            setStatus('error')
            setErrText('服务器未允许直连,也未提供转码链路')
            return
          }
          const url = tUrl.startsWith('http') ? new URL(tUrl).pathname + new URL(tUrl).search : tUrl
          setBadge('服务器转码')
          setSrc({ url, kind: 'transcode', ext: tUrl.includes('.m3u8') ? 'm3u8' : (ms.Container ?? 'ts').toLowerCase() })
        }
      } catch (e) {
        if (!cancelled) {
          setStatus('error')
          setErrText(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, itemId, navigate, profile])

  // ---------- 换源加载(官方 LoadOptions) ----------
  useEffect(() => {
    const player = playerRef.current
    if (!src || !player) return
    let cancelled = false
    srcRef.current = src
    ;(async () => {
      try {
        setStage('正在建立播放链路…')
        // 视频加载立即开始;字幕提取已在初始化时并行启动,起播后挂载
        const v0 = (msRef.current?.MediaStreams ?? []).find((x) => x.Type === 'Video')
        const br = v0?.BitRate ?? 0
        const preload = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.round((br / 8) * 20)))
        await player.load(src.url, {
          ...(src.ext ? { ext: src.ext } : {}),
          ...(src.kind === 'direct' ? { maxProbeDuration: 15 } : {}),
          ioLoaderOptions: {
            preload,
            retryCount: 30,
            retryInterval: 2,
            readTimeout: 20,
          },
        } as never)
        if (cancelled) return
        setStatus('ready')
        try {
          const streams = (playerRef.current?.getStreams?.() ?? []) as unknown as Array<{
            id: number
            mediaType: string
            codecparProxy?: { channels?: unknown }
          }>
          const auds = streams.filter((x) => x.mediaType === 'audio')
          setAudioTracks(auds.map((a, i) => ({
            id: a.id,
            label: `音轨 ${i + 1}${a.codecparProxy?.channels ? ` ${String(a.codecparProxy.channels)}ch` : ''}`,
          })))
          setSelectedAudioId(Number(playerRef.current?.getSelectedAudioStreamId?.() ?? -1))
        } catch { /* ignore */ }
        // 字幕装载:不阻塞视频,ready 后尽快挂上
        const subs = await (extSubsPRef.current ?? Promise.resolve([]))
        if (cancelled) return
        for (const s of subs) {
          void player.loadExternalSubtitle(s).catch((err) => console.warn('[subtitle] 装载失败', err))
        }
        if (subs.length) console.info(`[subtitle] 外挂字幕已装载:${subs.length} 条`)
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setErrText(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [src, prepareExternalSubs])

  // 卸载:停止上报 + 销毁
  useEffect(() => {
    return () => {
      const player = playerRef.current
      const posMs = Number(player?.currentTime ?? 0)
      try {
        void api
          .reportStopped({
            ItemId: itemId,
            MediaSourceId: msRef.current?.Id,
            PlaySessionId: playSessionRef.current,
            PositionTicks: Math.round((posMs / 1000) * 10_000_000),
          })
          .catch(() => {})
      } catch { /* ignore */ }
      void player?.destroy().catch(() => {})
      playerRef.current = null
      extSubsPRef.current = null
    }
  }, [api, itemId])

  // ---------- 进度上报(开始 + 每 10 秒) ----------
  useEffect(() => {
    if (status !== 'ready') return
    void api
      .reportPlayingStart({
        ItemId: itemId,
        MediaSourceId: msRef.current?.Id,
        PlaySessionId: playSessionRef.current,
        CanSeek: true,
      })
      .catch(() => {})
    // 就绪后 2.5 秒回写一次正确进度:自愈历史坏数据(如被写成 29.5 小时的位置)
    const heal = setTimeout(() => {
      const player = playerRef.current
      if (!player) return
      const sec = Number(player.currentTime ?? 0) / 1000
      void api
        .reportProgress({
          ItemId: itemId,
          MediaSourceId: msRef.current?.Id,
          PlaySessionId: playSessionRef.current,
          PositionTicks: Math.round(sec * 10_000_000),
          CanSeek: true,
          IsPaused: pausedRef.current,
        })
        .catch(() => {})
    }, 2500)
    const timer = setInterval(() => {
      const player = playerRef.current
      if (!player) return
      const sec = Number(player.currentTime ?? 0) / 1000
      void api
        .reportProgress({
          ItemId: itemId,
          MediaSourceId: msRef.current?.Id,
          PlaySessionId: playSessionRef.current,
          PositionTicks: Math.round(sec * 10_000_000),
          CanSeek: true,
          IsPaused: pausedRef.current,
        })
        .catch(() => {})
    }, 10_000)
    return () => {
      clearTimeout(heal)
      clearInterval(timer)
    }
  }, [status, api, itemId])

  // ---------- 看门狗:视频/音频停滞 ----------
  useEffect(() => {
    if (status !== 'ready') return
    const stall = { lastSec: 0, lastTs: 0, count: 0, reloadedAt: 0 }
    const audio = { count: 0, lastAt: 0 }
    const timer = setInterval(() => {
      const player = playerRef.current
      if (!player || pausedRef.current || !startedRef.current) return
      const sec = Number(player.currentTime ?? 0) / 1000
      const now = Date.now()
      if (stall.lastTs && Math.abs(sec - stall.lastSec) < 0.5 && now - stall.lastTs > 4000) {
        stall.count += 1
        if (stall.count >= 2 && now - stall.reloadedAt > 60_000) {
          stall.count = 0
          stall.reloadedAt = now
          console.warn(`[player] 视频停滞,重载 @ ${sec.toFixed(1)}s`)
          setStage('正在恢复播放…')
          void player
            .load(srcRef.current?.url ?? '', {
              ext: srcRef.current?.ext,
            } as never)
            .then(() => {
              void player.seek(BigInt(Math.round(sec * 1000))).catch(() => {})
              void player.play().catch(() => {})
            })
        }
      } else {
        stall.lastSec = sec
        stall.lastTs = now
      }
      const stats = player.getStats()
      const hasAudio = (msRef.current?.MediaStreams?.some((x) => x.Type === 'Audio')) ?? false
      if (hasAudio && stats) {
        const alive = Number(stats.audioRenderFramerate ?? 0) > 0 || Number(stats.audioDecodeFramerate ?? 0) > 0
        if (alive) {
          audio.count = 0
        } else {
          audio.count += 1
          if (audio.count === 4) {
            console.warn('[player] 音频渲染停滞,play() 恢复')
            void player.play().catch(() => {})
          } else if (audio.count >= 8 && now - audio.lastAt > 60_000) {
            audio.count = 0
            audio.lastAt = now
            console.warn(`[player] 音频恢复无效,重载 @ ${sec.toFixed(1)}s`)
            void player
              .load(srcRef.current?.url ?? '', { ext: srcRef.current?.ext } as never)
              .then(() => {
                void player.seek(BigInt(Math.round(sec * 1000))).catch(() => {})
                void player.play().catch(() => {})
              })
          }
        }
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [status, src])


  // ---------- 控制处理 ----------
  const togglePlay = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    if (pausedRef.current) {
      void player.play().catch(() => {})
      pausedRef.current = false
      setPaused(false)
    } else {
      player.pause()
      pausedRef.current = true
      setPaused(true)
    }
  }, [])

  const commitSeek = useCallback((targetSec: number) => {
    const player = playerRef.current
    if (!player) return
    const target = Math.max(0, Math.min(targetSec, dur || targetSec))
    seekLockRef.current = { target, until: Date.now() + 6000 }
    setCur(target)
    void player.seek(BigInt(Math.round(target * 1000))).catch(() => {})
  }, [dur])

  const seekTo = useCallback((sec: number) => {
    commitSeek(sec)
  }, [commitSeek])

  const changeVolume = useCallback((v: number) => {
    const player = playerRef.current
    if (!player) return
    player.setVolume(v)
    setVolume(v)
    setMuted(v === 0)
    try { localStorage.setItem('ewp/volume', String(v)) } catch { /* ignore */ }
  }, [])

  const toggleMute = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    if (muted) {
      const v = Number(localStorage.getItem('ewp/volume') ?? 1) || 1
      player.setVolume(v)
      setVolume(v)
      setMuted(false)
    } else {
      player.setVolume(0)
      setMuted(true)
    }
  }, [muted])

  const changeRate = useCallback((r: number) => {
    const player = playerRef.current
    if (!player) return
    player.setPlaybackRate(r)
    setRate(r)
  }, [])

  const toggleSub = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    const nv = !subOn
    player.setSubtitleEnable(nv)
    setSubOn(nv)
  }, [subOn])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void shellRef.current?.requestFullscreen?.()
  }, [])

  const selectAudio = useCallback(async (id: number) => {
    const player = playerRef.current
    if (!player) return
    try {
      await player.selectAudio(id)
      setSelectedAudioId(id)
    } catch (e) {
      console.warn('[player] 音轨切换失败', e)
    }
  }, [])

  // 自动隐藏控制栏:3 秒无操作隐藏,暂停时常显
  useEffect(() => {
    const wake = () => {
      setShowControls(true)
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = window.setTimeout(() => {
        if (!pausedRef.current) setShowControls(false)
      }, 3000)
    }
    wake()
    const el = shellRef.current
    el?.addEventListener('mousemove', wake)
    el?.addEventListener('touchstart', wake)
    return () => {
      el?.removeEventListener('mousemove', wake)
      el?.removeEventListener('touchstart', wake)
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    }
  }, [status])

  const fmt = (t: number) => {
    if (!isFinite(t) || t < 0) return '0:00'
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const sec = Math.floor(t % 60)
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
  }

  const playedPct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0

  // ---------- 播放链路统计(打开时持续采样,长久保活) ----------
  useEffect(() => {
    if (!diagOpen || status !== 'ready') return
    const collect = () => {
      const ui = playerRef.current
      if (!ui) return
      const ms = msRef.current
      const st = ui.getStats?.()
      const streams = ((ui.getStreams?.() ?? []) as unknown as Array<{ codecparProxy?: { codecType?: unknown; channels?: unknown } }>)
      const vCount = streams.filter((x) => Number(x.codecparProxy?.codecType) === 0).length
      const aCount = streams.filter((x) => Number(x.codecparProxy?.codecType) === 1).length
      const emby = ms?.MediaStreams ?? []
      const vEm = emby.find((x) => x.Type === 'Video')
      const aEm = emby.find((x) => x.Type === 'Audio' && x.IsDefault) ?? emby.find((x) => x.Type === 'Audio')
      // MSE 管线解码由浏览器完成,libmedia 的解码帧率恒为 0 —— 这是正常现象;
      // 码率改用 IO 字节增量计算(两种管线都准确)
      const isMSE = !!surfaceRef.current?.querySelector('video')
      const rx = Number(st?.bufferReceiveBytes ?? 0)
      const now = performance.now()
      const prev = rxPrevRef.current
      let mbps = 0
      if (prev && now > prev.t && rx >= prev.bytes) {
        mbps = ((rx - prev.bytes) * 8) / ((now - prev.t) / 1000) / 1_000_000
      }
      rxPrevRef.current = { bytes: rx, t: now }
      const vMbps = isMSE ? mbps : Number(st?.videoBitrate ?? 0) / 1_000_000
      const aMbps = 0
      const mbpsTotal = isMSE ? mbps : vMbps + aMbps
      bitrateHistRef.current = [...bitrateHistRef.current.slice(-39), mbpsTotal]
      setDiag({
        container: (ms?.Container ?? 'MKV').toUpperCase(),
        vCount,
        aCount,
        sCount: emby.filter((x) => x.Type === 'Subtitle').length,
        vCodec: (vEm?.Codec ?? '—').toUpperCase(),
        width: Number(st?.width ?? vEm?.Width ?? 0),
        height: Number(st?.height ?? vEm?.Height ?? 0),
        fps: Number(st?.videoRenderFramerate ?? 0),
        aCodec: (aEm?.Codec ?? '—').toUpperCase(),
        aCh: Number(aEm?.Channels ?? 0),
        aDec: Math.round(Number(st?.audioDecodeFramerate ?? 0)),
        aRen: Math.round(Number(st?.audioRenderFramerate ?? 0)),
        mbps: mbpsTotal.toFixed(1),
        vMbps: vMbps.toFixed(1),
        aMbps: (aMbps * 1000).toFixed(0),
        pipeline: isMSE ? 'MSE' : 'WASM',
        dropped: Number(st?.videoFrameDropCount ?? 0),
        decodeLabel: isMSE ? '浏览器解码' : 'WASM 软解',
      })
    }
    collect()
    const t = setInterval(collect, 1000)
    return () => clearInterval(t)
  }, [diagOpen, status])

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const player = playerRef.current
      if (!player) return
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          pausedRef.current ? void player.play().catch(() => {}) : player.pause()
          pausedRef.current = !pausedRef.current
          break
        case 'ArrowLeft':
          commitSeek(Number(player.currentTime ?? 0) / 1000 - (e.shiftKey ? 60 : 10))
          break
        case 'ArrowRight':
          commitSeek(Number(player.currentTime ?? 0) / 1000 + (e.shiftKey ? 60 : 10))
          break
        case 'Escape':
          if (!document.fullscreenElement) navigate(-1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, commitSeek])

  // ---------- 渲染 ----------
  return (
    <div
      ref={shellRef}
      className={`ui-player-page ${!showControls && status === 'ready' && !paused ? 'ui-hide-cursor' : ''}`}
      onMouseMove={() => setShowControls(true)}
    >
      {item && (
        <div className={`ui-top ${!showControls && status === 'ready' && !paused ? 'ui-hidden' : ''}`}>
          <button className="back-pill" onClick={() => navigate(-1)}>← 返回</button>
          <span className="ui-title">
            {item.Type === 'Episode' && item.SeriesName
              ? `${item.SeriesName} 第${item.ParentIndexNumber ?? '?'}季 第${item.IndexNumber ?? '?'}集 ${item.Name}`
              : item.Name}
          </span>
          {badge && <span className="ui-badge">{badge}</span>}
        </div>
      )}
      <div
        className="ui-surface"
        ref={surfaceRef}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      />
      {status === 'ready' && (
        <div className={`ui-controls ${!showControls && !paused ? 'ui-hidden' : ''}`}>
          <div className="ui-progress-row">
            <input
              type="range"
              min={0}
              max={1000}
              value={seekDragging ? seekPreview : dur > 0 ? Math.min(1000, Math.round((cur / dur) * 1000)) : 0}
              onPointerDown={(e) => { setSeekDragging(true); setSeekPreview(Number((e.target as HTMLInputElement).value)) }}
              onInput={(e) => { setSeekDragging(true); setSeekPreview(Number((e.target as HTMLInputElement).value)) }}
              onPointerUp={(e) => { setSeekDragging(false); commitSeek((Number((e.target as HTMLInputElement).value) / 1000) * dur) }}
              onKeyUp={() => { setSeekDragging(false); commitSeek((seekPreview / 1000) * dur) }}
              className="ui-progress"
              aria-label="进度"
            />
          </div>
          <div className="ui-buttons">
            <button onClick={togglePlay} title={paused ? '播放' : '暂停'}>{paused ? '▶' : '⏸'}</button>
            <span className="ui-time">{fmt(cur)} / {fmt(dur)}</span>
            <div className="ui-flex" />
            <button onClick={toggleSub} title="字幕" className={subOn ? 'ui-on' : 'ui-off'}>字</button>
            {audioTracks.length > 1 && (
              <div className="ui-menu-box">
                <button onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'audio' ? null : 'audio') }} title="音轨">音轨</button>
                {openMenu === 'audio' && (
                  <div className="ui-menu" onClick={(e) => e.stopPropagation()}>
                    {audioTracks.map((a) => (
                      <button key={a.id} className={`ui-menu-item ${selectedAudioId === a.id ? 'ui-on' : ''}`} onClick={() => { void selectAudio(a.id); setOpenMenu(null) }}>
                        {a.label}{selectedAudioId === a.id ? ' ✓' : ''}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="ui-menu-box">
              <button onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'speed' ? null : 'speed') }}>{rate}×</button>
              {openMenu === 'speed' && (
                <div className="ui-menu" onClick={(e) => e.stopPropagation()}>
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                    <button key={r} className={`ui-menu-item ${rate === r ? 'ui-on' : ''}`} onClick={() => { changeRate(r); setOpenMenu(null) }}>
                      {r}×{rate === r ? ' ✓' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={toggleMute} title="静音">{muted || volume === 0 ? '🔇' : '🔊'}</button>
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : Math.round(volume * 100)}
              onChange={(e) => changeVolume(Number(e.target.value) / 100)}
              className="ui-volume"
              aria-label="音量"
            />
            <div className="ui-menu-box">
              <button
                onClick={(e) => { e.stopPropagation(); setMoreOpen(moreOpen ? false : !moreOpen) }}
                title="更多"
              >⋮</button>
              {moreOpen && (
                <div className="ui-menu" onClick={(e) => e.stopPropagation()}>
                  <button className="ui-menu-item" onClick={() => { setDiagOpen((v) => !v); setMoreOpen(false) }}>
                    {diagOpen ? '隐藏统计' : '显示统计'}
                  </button>
                </div>
              )}
            </div>
            <button onClick={toggleFullscreen} title="全屏">⛶</button>
          </div>
        </div>
      )}
      {diagOpen && (
        <div className="ui-diag" onClick={(e) => e.stopPropagation()}>
          <div className="ui-diag-head">
            <span>⚡ 播放链路</span>
            <button onClick={() => setDiagOpen(false)}>✕</button>
          </div>
          <div className="ui-diag-ok">✓ 链路正常</div>
          {diag && (
            <>
              <div className="ui-diag-sec">源</div>
              <div className="ui-diag-v strong">{diag.container} 容器</div>
              <div className="ui-diag-v dim">视频 {diag.vCount} · 音频 {diag.aCount} · 字幕 {diag.sCount}</div>
              <div className="ui-diag-sec">网络</div>
              <div className="ui-diag-v strong">{diag.mbps} Mbps</div>
              <svg className="ui-diag-spark" viewBox="0 0 120 24" preserveAspectRatio="none">
                <polyline
                  fill="none"
                  stroke="#ff6b9d"
                  strokeWidth="1.5"
                  points={(() => {
                    const h = bitrateHistRef.current.slice(-40)
                    if (h.length < 2) return '0,24 120,24'
                    const max = Math.max(...h, 0.1)
                    return h.map((v, i) => `${(i / (h.length - 1)) * 120},${24 - (v / max) * 22}`).join(' ')
                  })()}
                />
              </svg>
              <div className="ui-diag-sec">解码</div>
              <div className="ui-diag-v strong">{diag.vCodec} · {diag.width}×{diag.height}{diag.pipeline === 'WASM' ? ` · ${diag.fps.toFixed(2)}fps` : ''}</div>
              <div className="ui-diag-v dim">音频 {diag.aCodec}{diag.aCh ? ` ${diag.aCh}ch` : ''} · {diag.decodeLabel}</div>
              <div className="ui-diag-sec">渲染</div>
              <div className="ui-diag-v">{diag.pipeline === 'MSE' ? '播放器 MSE 画面' : '播放器自渲染画面'}</div>
              <div className="ui-diag-sec">显示</div>
              <div className="ui-diag-v">SDR 呈现</div>
            </>
          )}
        </div>
      )}
      {status === 'loading' && <div className="ui-loading">{stage}</div>}
      {status === 'error' && (
        <div className="ui-error">
          <p>{errText || '播放失败'}</p>
          <button onClick={() => { setStatus('loading'); setErrText(''); if (src) setSrc({ ...src }) }}>重试</button>
          <button onClick={() => navigate(-1)}>返回</button>
        </div>
      )}
    </div>
  )
}
