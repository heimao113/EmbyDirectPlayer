/**
 * 官方 libmedia AVPlayerUI 播放页(重构版)。
 *
 * 播放层完全采用 libmedia 官方能力:
 * - AVPlayerUI(带 UI 的播放器):控制栏/设置/字幕音轨菜单/键盘全部官方内置
 * - MSE → WebCodecs 硬解 → WASM 软解 的降级由 libmedia 内部处理
 * - 内嵌字幕(含 ASS 样式与 MKV 内嵌字体)由 libmedia 内置字幕渲染器处理
 *
 * 本页面只保留 Emby 胶水:
 * - PlaybackInfo 决策(直连 / 音频兜底 remux)
 * - 续播定位、进度上报、看完标记、下一集
 * - 外挂字幕与"libmedia 解不出内嵌字幕轨"时的 Emby 提取兜底(loadExternalSubtitle)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AVPlayerUI from '@libmedia/avplayer-ui'
import { Events } from '@libmedia/avplayer'
import { AVCodecID } from '@libmedia/avutil/enum'
import { useApp } from '../state'
import type { BaseItem, MediaSource, MediaStream } from '../api/types'
import { buildDeviceProfile, isAudioLocallyDecodable, pickPreferredAudioIndex } from '../player/deviceProfile'
import { fetchSubtitleText } from '../player/subtitles'

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

export default function PlayerUIPage() {
  const navigate = useNavigate()
  const { id: itemId = '' } = useParams<{ id: string }>()
  const { api } = useApp()

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const uiRef = useRef<AVPlayerUI | null>(null)
  const msRef = useRef<MediaSource | null>(null)
  const playSessionRef = useRef<string | undefined>(undefined)
  const pendingSeekRef = useRef(0)
  const startedRef = useRef(false)
  const pausedRef = useRef(false)
  const extLoadedRef = useRef(false)
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

  // ---------- 创建官方 AVPlayerUI(一次) ----------
  useEffect(() => {
    if (!surfaceRef.current || uiRef.current) return
    const uiBestStream = (streams: Array<{ id?: number; index?: number; disposition?: number }>, mediaType: number) => {
        console.info('[ui-player] findBestStream called, mediaType =', mediaType)
        const proxies = (uiRef.current?.getStreams?.() ?? []) as unknown as Array<{ id: number; codecparProxy?: Record<string, unknown> }>
        const cpOf = (id?: number) => proxies.find((x) => x.id === id)?.codecparProxy
        const pool = (streams as Array<{ id?: number; index?: number; disposition?: number }>).filter((s) => {
          const cp = cpOf(s.id)
          return cp ? Number(cp.codecType) === mediaType : false
        })
        if (mediaType === 1) {
          const hintCh = (msRef.current?.MediaStreams ?? []).find((x) => x.Type === 'Audio')?.Channels ?? 0
          for (const s of pool) {
            const cp = cpOf(s.id) as
              | { chLayout?: { order: unknown; nbChannels: number; u: { mask: bigint } } }
              | undefined
            const layout = cp?.chLayout
            if (!layout) continue
            const nb = Number(layout.nbChannels ?? 0)
            if (nb > 0 && Number(layout.order) === 0) {
              // UNSPEC 无掩码 → 补该声道数的标准布局
              layout.order = 1 as unknown as typeof layout.order
              layout.u.mask = CHANNEL_DEFAULT_MASK[nb] ?? 0x3Fn
            } else if (nb <= 0 && hintCh > 0) {
                  // demuxer 填出无效声道 → 用 Emby 元数据的真实声道数修复
              layout.nbChannels = hintCh
              layout.order = 1 as unknown as typeof layout.order
              layout.u.mask = CHANNEL_DEFAULT_MASK[hintCh] ?? 0x3Fn
            }
          }
          if (hintRef.current !== undefined) {
            const hinted = pool.find((s) => s.index === hintRef.current)
            if (hinted) return hinted
          }
        }
        return pool[0]
    }

    const ui = new AVPlayerUI({
      container: surfaceRef.current,
      getWasm: getWasm as never,
      enableWorker: globalThis.crossOriginIsolated === true,
      // 注意:AVPlayerUI 不透传 findBestStream 选项,构造后在实例 options 上注入(见下)
      // 1) AAC 5.1 无声道布局修复:libmedia demuxer 对部分 AAC 轨写出的 chLayout 无效
      //    (nbChannels=-1 或 UNSPEC 无掩码)→ wasm 解码器 open 失败 -28 → 永远起不来。
      //    注意:streams 里的 codecpar 是裸堆地址(数字),必须经 getStreams() 的
      //    codecparProxy(accessof 包装,可读写同一块堆内存)修补。
      // 2) 音轨优选:默认轨本地解不了(TrueHD)→ 选同文件可解的备用音轨(AC3 等)。
    } as never)
    uiRef.current = ui
    ;(window as unknown as Record<string, unknown>).__uiPlayer = ui
    // AVPlayerUI 不透传 findBestStream 选项(实测),load 阶段才消费——构造后注入即可生效
    const uiOpts = (ui as unknown as { options: Record<string, unknown> }).options
    if (uiOpts) uiOpts.findBestStream = uiBestStream

    // 生命周期:Loaded → 续播定位 + 播放;PAUSED/PLAYED 跟踪;ENDED → 看完 + 下一集
    ui.on(Events.LOADED, () => {
      startedRef.current = true
      setStatus('ready')
      setStage('')
      const seek = pendingSeekRef.current
      if (seek > 0) {
        pendingSeekRef.current = 0
        void ui.seek(BigInt(Math.round(seek * 1000))).catch(() => {})
      }
      void ui.play().catch(() => {})
    })
    ui.on(Events.PAUSED, () => { pausedRef.current = true })
    ui.on(Events.PLAYED, () => { pausedRef.current = false })
    ui.on(Events.TIME, () => { if (pausedRef.current) pausedRef.current = false })
    ui.on(Events.ENDED, () => {
      const ms = msRef.current
      void api.reportStopped({
        ItemId: itemId,
        MediaSourceId: ms?.Id,
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
    console.info('[ui-player] init itemId =', JSON.stringify(itemId), 'pathname =', location.pathname)
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

        // 音轨优选:默认音轨本地解不了(TrueHD)→ 同文件可解的备用音轨(AC3 等)
        const audioStreams = (ms.MediaStreams ?? []).filter((x) => x.Type === 'Audio')
        hintRef.current = pickPreferredAudioIndex(
          audioStreams.map((x) => ({ index: x.Index, codec: x.Codec, channels: x.Channels, isDefault: x.IsDefault })),
          false,
        )

        // 音频兜底(P0-1):默认音轨本地解不了且有 remux 链 → 整条切 remux
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

  // ---------- 换源加载 ----------
  useEffect(() => {
    const ui = uiRef.current
    if (!src || !ui) return
    let cancelled = false
    ;(async () => {
      try {
        setStage('正在建立播放链路…')
        // Range 预载按码率估算(8–64MB)+ 重试参数:冷启动/慢网 analyze 不再超时
        const v0 = (msRef.current?.MediaStreams ?? []).find((x) => x.Type === 'Video')
        const br = v0?.BitRate ?? 0
        const preload = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.round((br / 8) * 20)))
        await ui.load(src.url, {
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
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setErrText(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [src])

  // ---------- 外挂/提取字幕兜底 ----------
  useEffect(() => {
    if (status !== 'ready' || extLoadedRef.current) return
    const ms = msRef.current
    const ui = uiRef.current
    if (!ms || !ui) return
    extLoadedRef.current = true
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // libmedia demux 出的字幕流为 0(部分 MKV,如罪恶王冠)且 Emby 有文本字幕 → 外挂兜底
          const demuxSubs = ((ui.getStreams?.() ?? []) as Array<{ codecparProxy?: { codecType?: unknown } }>)
            .filter((s) => Number(s.codecparProxy?.codecType) === 3)
          const embyTextSubs = (ms.MediaStreams ?? []).filter(
            (x) =>
              x.Type === 'Subtitle' &&
              x.IsTextSubtitleStream !== false &&
              !['pgs', 'pgssub', 'dvdsub', 'sup', 'dvbsub'].includes((x.Codec ?? '').toLowerCase()),
          )
          if (demuxSubs.length > 0 || embyTextSubs.length === 0) return
          const def =
            embyTextSubs.find((s) => s.IsDefault) ??
            embyTextSubs.find((s) => (s.Language ?? '').toLowerCase().startsWith('zh')) ??
            embyTextSubs[0]
          const raw = await fetchSubtitleText(
            api,
            { index: def.Index, label: def.DisplayTitle ?? '', codec: def.Codec ?? '', isText: true, isGraphic: false, deliveryUrl: def.DeliveryUrl },
            itemId,
            ms.Id,
          )
          const file = new File([raw], `subtitle.${def.Codec === 'subrip' ? 'srt' : def.Codec}`, { type: 'text/plain' })
          await ui.loadExternalSubtitle({ source: file, lang: def.Language ?? def.Codec, title: def.DisplayTitle ?? def.Title ?? '字幕' })
          console.info(`[subtitle] 外挂兜底:轨 ${def.Index} ${def.Codec} ${Math.round(raw.length / 1024)}KB`)
        } catch (e) {
          console.warn('[subtitle] 外挂兜底失败', e)
        }
      })()
    }, 3000)
    return () => clearTimeout(timer)
  }, [status, api, itemId])

  // ---------- 进度上报 ----------
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
    const timer = setInterval(() => {
      const ui = uiRef.current
      if (!ui) return
      const posMs = Number(ui.currentTime ?? 0)
      void api
        .reportProgress({
          ItemId: itemId,
          MediaSourceId: msRef.current?.Id,
          PlaySessionId: playSessionRef.current,
          PositionTicks: Math.round((posMs / 1000) * 10_000_000),
          CanSeek: true,
          IsPaused: pausedRef.current,
          PlayMethod: srcRef.current?.kind === 'transcode' ? 'Transcode' : srcRef.current?.kind === 'direct-stream' ? 'DirectStream' : 'DirectPlay',
        })
        .catch(() => {})
    }, 10_000)
    return () => clearInterval(timer)
  }, [status, api, itemId, src])

  // 卸载:停止上报 + 销毁
  useEffect(() => {
    return () => {
      const ui = uiRef.current
      const posMs = Number(ui?.currentTime ?? 0)
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
      void ui?.destroy().catch(() => {})
      uiRef.current = null
    }
  }, [api, itemId])

  // ---------- 看门狗:视频/音频停滞 ----------
  useEffect(() => {
    if (status !== 'ready') return
    const stall = { lastSec: 0, lastTs: 0, count: 0, reloadedAt: 0 }
    const audio = { count: 0, lastAt: 0 }
    const timer = setInterval(() => {
      const ui = uiRef.current
      if (!ui || pausedRef.current || !startedRef.current) return
      const sec = Number(ui.currentTime ?? 0) / 1000
      const now = Date.now()
      // 视频停滞:4 秒时间没走 → 重载(限速 2 次/60s)
      if (stall.lastTs && Math.abs(sec - stall.lastSec) < 0.5 && now - stall.lastTs > 4000) {
        stall.count += 1
        if (stall.count >= 2 && now - stall.reloadedAt > 60_000) {
          stall.count = 0
          stall.reloadedAt = now
          console.warn(`[ui-player] 视频停滞,重载 @ ${sec.toFixed(1)}s`)
          setStage('正在恢复播放…')
          void ui
            .load(srcRef.current?.url ?? '', { ext: srcRef.current?.ext } as never)
            .then(() => {
              void ui.seek(BigInt(Math.round(sec * 1000))).catch(() => {})
              void ui.play().catch(() => {})
            })
        }
      } else {
        stall.lastSec = sec
        stall.lastTs = now
      }
      // 音频停滞:视频走、音频渲染帧率 0 持续 4s → play() 拉起;再 4s → 重载
      const stats = ui.getStats()
      const hasAudio = (msRef.current?.MediaStreams?.some((x) => x.Type === 'Audio')) ?? false
      if (hasAudio && stats) {
        const alive = Number(stats.audioRenderFramerate ?? 0) > 0 || Number(stats.audioDecodeFramerate ?? 0) > 0
        if (alive) {
          audio.count = 0
        } else {
          audio.count += 1
          if (audio.count === 4) {
            console.warn('[ui-player] 音频渲染停滞,play() 恢复')
            void ui.play().catch(() => {})
          } else if (audio.count >= 8 && now - audio.lastAt > 60_000) {
            audio.count = 0
            audio.lastAt = now
            console.warn(`[ui-player] 音频恢复无效,重载 @ ${sec.toFixed(1)}s`)
            void ui
              .load(srcRef.current?.url ?? '', { ext: srcRef.current?.ext } as never)
              .then(() => {
                void ui.seek(BigInt(Math.round(sec * 1000))).catch(() => {})
                void ui.play().catch(() => {})
              })
          }
        }
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [status, src])

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
