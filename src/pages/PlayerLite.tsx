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

  const [item, setItem] = useState<BaseItem | null>(null)
  const [src, setSrc] = useState<SrcInfo | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errText, setErrText] = useState('')
  const [stage, setStage] = useState('正在建立播放链路…')
  const [badge, setBadge] = useState('')

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
      const seek = pendingSeekRef.current
      if (seek > 0) {
        pendingSeekRef.current = 0
        void player.seek(BigInt(Math.round(seek * 1000))).catch(() => {})
      }
      void player.play().catch(() => {})
    })
    player.on(Events.PAUSED, () => { pausedRef.current = true })
    player.on(Events.PLAYED, () => { pausedRef.current = false })
    player.on(Events.TIME, () => { if (pausedRef.current) pausedRef.current = false })
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
        // 官方外挂字幕:Emby 提取的字幕以 externalSubtitles 随 load 一起装载
        const externalSubtitles = await prepareExternalSubs()
        if (cancelled) return
        const v0 = (msRef.current?.MediaStreams ?? []).find((x) => x.Type === 'Video')
        const br = v0?.BitRate ?? 0
        const preload = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.round((br / 8) * 20)))
        await player.load(src.url, {
          ...(src.ext ? { ext: src.ext } : {}),
          ...(src.kind === 'direct' ? { maxProbeDuration: 15 } : {}),
          ...(externalSubtitles.length ? { externalSubtitles } : {}),
          ioLoaderOptions: {
            preload,
            retryCount: 30,
            retryInterval: 2,
            readTimeout: 20,
          },
        } as never)
        if (cancelled) return
        setStatus('ready')
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
    }
  }, [api, itemId])

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
          void player.seek(BigInt(Math.max(0, Number(player.currentTime ?? 0) / 1000 - (e.shiftKey ? 60 : 10)) * 1000 | 0)).catch(() => {})
          break
        case 'ArrowRight':
          void player.seek(BigInt(Math.round(Number(player.currentTime ?? 0) / 1000 + (e.shiftKey ? 60 : 10)) * 1000)).catch(() => {})
          break
        case 'Escape':
          if (!document.fullscreenElement) navigate(-1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // ---------- 渲染 ----------
  return (
    <div className="ui-player-page">
      {item && (
        <div className="ui-top">
          <button className="back-pill" onClick={() => navigate(-1)}>← 返回</button>
          <span className="ui-title">
            {item.Type === 'Episode' && item.SeriesName
              ? `${item.SeriesName} 第${item.ParentIndexNumber ?? '?'}季 第${item.IndexNumber ?? '?'}集 ${item.Name}`
              : item.Name}
          </span>
          {badge && <span className="ui-badge">{badge}</span>}
        </div>
      )}
      <div className="ui-surface" ref={surfaceRef} />
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
