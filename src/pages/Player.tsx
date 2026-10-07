import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { loadPlaySession } from '../player/session'
import { useApp } from '../state'
import { buildDeviceProfile, detectAc3Support } from '../player/deviceProfile'
import { fetchSubtitleText, toUnifiedAss, assToVtt, parseAssCues, cuesToSrt, sniffSubtitleFormat, type SubCue } from '../player/subtitles'
import { loadFontManifest, registerFontFaces, toJassubFontConfig } from '../player/fonts'
import { JassubHost } from '../player/jassubHost'
import { Engine, type EngineStream, type PipelineKind } from '../player/engine'
import { isAudioLocallyDecodable, pickPreferredAudioIndex } from '../player/deviceProfile'
import { NativeEngine } from '../player/native'
import type { BaseItem, MediaSource, MediaStream } from '../api/types'
import type { AudioTrackOption, SubTrack } from './playerTypes'

/** 字幕文本缓存:开播前预取,applySubtitle 直接命中,省掉起播后串行的提取请求 */
const subTextCache = new Map<string, string>()
const subTextKey = (itemId: string, msId: string | undefined, index: number) => `${itemId}/${msId}/${index}`

// 覆盖画布对齐用的全局单例观察器已随 JASSUB 方案移除;字幕统一走 libmedia 原生渲染

/** MSE 失败记忆:某编码组合 MSE 打不开时记住,本浏览器后续不再尝试(省一次重建) */
function mseFailMemo(): Set<string> {
  const w = window as any
  if (!w.__ewp_msefail) {
    try { w.__ewp_msefail = new Set(JSON.parse(localStorage.getItem('ewp/msefail') ?? '[]')) }
    catch { w.__ewp_msefail = new Set() }
  }
  return w.__ewp_msefail
}
function memoMseFail(key: string) {
  const set = mseFailMemo()
  set.add(key)
  try { localStorage.setItem('ewp/msefail', JSON.stringify([...set])) } catch { /* ignore */ }
}

const AUDIO_CODEC_LABEL: Record<string, string> = {
  AAC: 'AAC', MP3: 'MP3', FLAC: 'FLAC', OPUS: 'Opus', VORBIS: 'Vorbis',
  DTS: 'DTS', EAC3: 'E-AC-3', AC3: 'AC-3', TRUEHD: 'TrueHD', PCM: 'PCM',
  MP2: 'MP2', ALAC: 'ALAC', PCM_S16LE: 'PCM',
}

interface SrcInfo {
  url: string
  kind: 'direct' | 'direct-native' | 'direct-stream' | 'transcode'
  ext?: string
  /** true = 视频原样直连、仅音频由服务器转 AAC(kind=direct-stream) */
  audioTranscoded?: boolean
}

const T = (ticks?: number | null) => (ticks ?? 0) / 10_000_000 // ticks → 秒

function buildSubTrack(stream: MediaStream, itemId: string, msId: string): SubTrack {
  const codec = (stream.Codec ?? '').toLowerCase()
  // 位图字幕:libass 画不了,交 libmedia 原生渲染(pgssub 是 Emby 对 PGS 的常见写法,勿漏)
  const graphic = ['pgs', 'pgssub', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvdsub', 'dvbsub', 'vobsub', 'sup'].includes(codec)
  // 其余编码按文本轨处理,具体格式由内容嗅探决定(不信任 Emby 的 Codec 字段)
  const isText = !graphic
  const lang = stream.Language ? `[${stream.Language}] ` : ''
  const label = `${lang}${stream.DisplayTitle ?? stream.Title ?? `轨道 ${stream.Index}`}`
  return {
    index: stream.Index,
    label,
    codec,
    isText,
    isGraphic: graphic,
    deliveryUrl:
      stream.DeliveryUrl ??
      `/emby/Videos/${itemId}/${msId}/Subtitles/${stream.Index}/Stream.${codec === 'subrip' ? 'srt' : codec}`,
  }
}

function buildAudioTrack(s: EngineStream): AudioTrackOption {
  const codec = AUDIO_CODEC_LABEL[s.codec] ?? s.codec
  const parts = [
    codec,
    s.channels ? `${s.channels}ch` : '',
    s.language ? `[${s.language}]` : '',
    s.title,
  ].filter(Boolean)
  return {
    id: s.id,
    index: s.index,
    label: parts.join(' '),
    codec: s.codec,
    language: s.language,
    channels: s.channels,
    isDefault: s.isDefault,
  }
}


/** 控制栏 SVG 图标(uhd 同款扁平风格) */
function Icon({ d, size = 22, extra }: { d: string; size?: number; extra?: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={d} />
      {extra}
    </svg>
  )
}
const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  back10: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
  fwd10: 'M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  speed: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
}

/* SVG 图标控制按钮 */
function CtrlIcon({ name, title, onClick, className, children }: {
  name: keyof typeof ICONS
  title: string
  onClick?: (e: React.MouseEvent) => void
  className?: string
  children?: React.ReactNode
}) {
  return (
    <button className={`ctrl-btn ${className ?? ''}`} onClick={onClick} title={title}>
      {children ?? <Icon d={ICONS[name]} />}
    </button>
  )
}

export default function Player() {
  const { id: itemId } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session')
  const navigate = useNavigate()
  const { api } = useApp()

  const surfaceRef = useRef<HTMLDivElement | null>(null) // engine 渲染面挂载点
  const shellRef = useRef<HTMLDivElement | null>(null)
  const engineRef = useRef<Engine | NativeEngine | null>(null)
  const srcRef = useRef<SrcInfo | null>(null)
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const playSessionRef = useRef<string | null>(null)
  const resumeDoneRef = useRef(false)
  const stallRef = useRef({ lastSec: 0, lastTs: 0, failures: 0 })
  const loadTokenRef = useRef(0)
  const activeSubRef = useRef<number | null>(null)
  const reportRef = useRef({ paused: true })
  const lastTimeRef = useRef(0)
  const lastAdvanceRef = useRef(0)
  const userPausedRef = useRef(false)
  const stallUiCount = useRef(0)
  const startedRef = useRef(false)
  const prevSecRef = useRef(0)
  const resumedAtRef = useRef(0)
  const pendingSeekRef = useRef<number | null>(null)
  // 播放停滞自愈:每个片源最多重载续播 3 次
  const recoveryRef = useRef({ count: 0, lastAt: 0 })
  const seekVerifyRef = useRef<{ target: number; at: number; reloading: boolean } | null>(null)
  const [seekLoading, setSeekLoading] = useState(false)
  const reportStateRef = useRef<((event: 'progress' | 'stop') => void) | null>(null)
  const msePreferredRef = useRef(false)
  const mseKeyRef = useRef('')
  const statusRef = useRef<'loading' | 'ready' | 'error'>('loading')
  const [hwHint, setHwHint] = useState('')
  const [trOpen, setTrOpen] = useState(false)
  const [trCues, setTrCues] = useState<SubCue[]>([])
  const [trQuery, setTrQuery] = useState('')
  const [trFollow, setTrFollow] = useState(() => localStorage.getItem('ewp/trfollow') !== '0')
  const trListRef = useRef<HTMLDivElement | null>(null)
  const startupAttemptsRef = useRef(0)
  const fallbackUsedRef = useRef(false)
  const forceLibmediaRef = useRef(false)
  /** 用户在详情页明确选择的线路;选了原画时看门狗不再自动切转码 */
  const explicitModeRef = useRef<'direct' | 'transcode' | null>(null)

  const [item, setItem] = useState<BaseItem | null>(null)
  const [mediaSource, setMediaSource] = useState<MediaSource | null>(null)
  const [src, setSrc] = useState<SrcInfo | null>(null)
  const [pipeline, setPipeline] = useState<PipelineKind>('unknown')
  const [pipelineReason, setPipelineReason] = useState('')
  const [wasmOnly, setWasmOnly] = useState(false)
  const [subs, setSubs] = useState<SubTrack[]>([])
  const [audioTracks, setAudioTracks] = useState<AudioTrackOption[]>([])
  const [selectedAudioId, setSelectedAudioId] = useState<number | null>(null)
  const [activeSub, setActiveSub] = useState<number | null>(null)
  const [subError, setSubError] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  // 播放器 UI 状态
  const [paused, setPaused] = useState(true)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('ewp/volume') ?? 1))
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [showControls, setShowControls] = useState(true)
  const [openMenu, setOpenMenu] = useState<'sub' | 'audio' | 'speed' | 'diag' | 'more' | null>(null)
  // 进度条拖动:拖动中只更新预览,松手才真正 seek(否则 demuxer 反复中断,体验极差)
  const [seekPreview, setSeekPreview] = useState<number | null>(null)
  const [stalledUi, setStalledUi] = useState(false)
  const [bufferedPct, setBufferedPct] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // 播放链路诊断面板数据(1s 刷新);速率用累计字节差分计算,不依赖 libmedia 内部单位
  const [diag, setDiag] = useState<{
    stats: ReturnType<Engine['statsSnapshot']>
    decoder: ReturnType<Engine['decoderInfo']>
    streams: EngineStream[]
    selected: { video: number | null; audio: number | null; subtitle: number | null }
    rxMbps: number | null
  } | null>(null)

  // 文稿面板:当前 cue 索引 + 跟随滚动
  const trCurIdx = useMemo(() => {
    if (!trCues.length) return -1
    let idx = -1
    for (let i = 0; i < trCues.length; i++) {
      if (cur >= trCues[i].start && cur < trCues[i].end) return i
      if (trCues[i].start > cur) { idx = i - 1; break }
      idx = i
    }
    return idx
  }, [cur, trCues])

  useEffect(() => {
    if (!trOpen || !trFollow || trCurIdx < 0) return
    const el = trListRef.current?.querySelector(`[data-idx="${trCurIdx}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [trCurIdx, trOpen, trFollow])

  // 面板展示数据:原生引擎 streams 为空时,用 Emby 元数据补全
  const embyTracks = mediaSource?.MediaStreams ?? []
  const trackCount = diag && diag.streams.length > 0 ? diag.streams.length : embyTracks.length
  const videoCount = diag && diag.streams.length > 0
    ? diag.streams.filter((s) => s.mediaType === 'video').length
    : embyTracks.filter((s) => s.Type === 'Video').length
  const audioCount = diag && diag.streams.length > 0
    ? diag.streams.filter((s) => s.mediaType === 'audio').length
    : embyTracks.filter((s) => s.Type === 'Audio').length
  const subtitleCount = diag && diag.streams.length > 0
    ? diag.streams.filter((s) => s.mediaType === 'subtitle').length
    : embyTracks.filter((s) => s.Type === 'Subtitle').length
  const engineIsNative = srcRef.current?.kind === 'direct-native'

  useEffect(() => {
    if (status !== 'ready' || openMenu !== 'diag') {
      setDiag(null)
      return
    }
    let lastRx: number | null = null
    let lastTs = 0
    const sample = () => {
      const e = engineRef.current
      if (!e) return
      const st = e.statsSnapshot()
      // 真实吞吐 = 累计接收/缓冲字节的差分
      let rxMbps: number | null = null
      if (st && lastRx !== null && lastTs) {
        const dtSec = (Date.now() - lastTs) / 1000
        if (dtSec > 0) rxMbps = Math.max(0, ((st.rxBytes - lastRx) * 8) / dtSec / 1_000_000)
      }
      if (st) { lastRx = st.rxBytes; lastTs = Date.now() }
      setDiag({
        stats: st,
        decoder: e.decoderInfo(),
        streams: e.streams(),
        selected: { video: e.selectedVideoId(), audio: e.selectedAudioId(), subtitle: e.selectedSubtitleId() },
        rxMbps,
      })
    }
    sample()
    const timer = setInterval(sample, 1000)
    return () => clearInterval(timer)
  }, [status, openMenu])

  /** 字幕文本:缓存命中直接返回,未命中请求并落缓存 */
  const fetchSubTextCached = useCallback(
    async (track: SubTrack): Promise<string> => {
      const key = subTextKey(itemId!, mediaSourceRef.current?.Id, track.index)
      const hit = subTextCache.get(key)
      if (hit !== undefined) return hit
      const text = await fetchSubtitleText(api, track, itemId!, mediaSourceRef.current!.Id)
      subTextCache.set(key, text)
      return text
    },
    [api, itemId],
  )

  const jassubRef = useRef<JassubHost | null>(null)
  const getJassub = () => (jassubRef.current ??= new JassubHost())
  const pipelineRef = useRef<PipelineKind>('unknown')
  const audioFallbackUsedRef = useRef(false)
  const streamFallbackUsedRef = useRef(false)
  const audioStallRef = useRef(0)
  const hasAudioStreamRef = useRef(true)
  const audioReloadRef = useRef({ count: 0, lastAt: 0 })

  const lastNativeSubIdRef = useRef<number | null>(null)

  const supportsAc3 = useMemo(detectAc3Support, [])
  const profile = useMemo(() => buildDeviceProfile(supportsAc3), [supportsAc3])
  /** 整条切 remux(视频 -c copy 仅音频转 AAC);无可用 remux 链返回 false */
  const switchToRemux = useCallback(async (): Promise<boolean> => {
    let remux = (mediaSourceRef.current?.DirectStreamUrl ?? mediaSourceRef.current?.TranscodingUrl ?? '').trim()
    if (!remux) {
      const tr = await api.playbackInfo(itemId!, profile, 0, true).catch(() => null)
      const ms2 = tr?.MediaSources?.[0]
      if (ms2) {
        mediaSourceRef.current = ms2
        remux = (ms2.DirectStreamUrl ?? ms2.TranscodingUrl ?? '').trim()
      }
    }
    if (!remux) return false
    const url = remux.startsWith('http') ? new URL(remux).pathname + new URL(remux).search : remux
    const ext = (url.match(/\.(mkv|ts|m3u8|mp4)(?:$|\?)/i)?.[1] ?? 'mkv').toLowerCase()
    setSrc({ url, kind: 'direct-stream', ext, audioTranscoded: true })
    return true
  }, [api, itemId, profile])


  // ---------- 字幕轨切换(libmedia 原生渲染) ----------
  const applySubtitle = useCallback(
    async (subIndex: number | null) => {
      activeSubRef.current = subIndex
      const engine = engineRef.current
      if (!engine) return
      // DOM 字体注册:libmedia 字幕是 DOM 渲染,靠 CSS 字体匹配
      void registerFontFaces()
      const track = subIndex === null ? undefined : subs.find((t) => t.index === subIndex)
      try {
        if (!track) {
          await getJassub().detach()
          await engine.setNativeSubtitleEnabled(false)
          lastNativeSubIdRef.current = null
          setTrCues([])
          setSubError('')
          return
        }
        const s = srcRef.current
        // direct 与 direct-stream(TrueHD 等音频兜底 remux)都是 libmedia 直连 MKV,
        // 字幕主路径相同:文本轨 JASSUB,位图轨 libmedia
        if (s?.kind === 'direct' || s?.kind === 'direct-stream') {
          const lm = engine
            .streams()
            .find((x) => x.mediaType === 'subtitle' && x.index === track.index)
            ?? engine.streams().find((x) => x.mediaType === 'subtitle')
          if (track.isGraphic) {
            // PGS/DVB 位图:libass 画不了 → libmedia 原生渲染(同轨重复选择会刷错误日志,跳过)
            await getJassub().detach()
            await engine.setNativeSubtitleEnabled(true)
            if (lm && lastNativeSubIdRef.current !== lm.id) {
              await engine.selectSubtitle(lm.id)
              lastNativeSubIdRef.current = lm.id
            }
            if (!lm) setSubError('图形字幕在该文件上不可用')
            return
          }
          if (engine instanceof Engine) {
            // 文本轨 → JASSUB(libass)接管;内容走 Emby 提取接口(demux 出的轨不带完整 Style)。
            // 单轨失败(提取空/格式坏)自动按"同语言优先"尝试其它文本轨,最多 3 条,
            // 任何一条轨失败都不拖垮字幕系统
            const vs = engine.streams().find((x) => x.mediaType === 'video')
            const attachText = async (t: SubTrack): Promise<void> => {
              const t0 = performance.now()
              const raw = await fetchSubTextCached(t)
              const detected = sniffSubtitleFormat(raw)
              const unified = toUnifiedAss(raw, vs?.width || 1280, vs?.height || 720)
              const cues = parseAssCues(unified)
              setTrCues(cues) // 文稿面板数据
              if (!surfaceRef.current) return
              const cfg = toJassubFontConfig(await loadFontManifest())
              try {
                await getJassub().attach({
                  surface: surfaceRef.current,
                  assContent: unified,
                  availableFonts: cfg.availableFonts,
                  defaultFont: cfg.fallback || 'sans-serif',
                  video:
                    pipelineRef.current === 'mse'
                      ? engine.attachPoint().video
                      : undefined,
                  getSec: () => engine.currentSec(),
                  videoWidth: vs?.width,
                  videoHeight: vs?.height,
                  fonts: engine.embeddedFonts(),
                })
              } catch (e) {
                // JASSUB 起不来(环境不支持 worker 渲染等)→ 回退 libmedia 原生渲染
                console.warn('[subtitle] JASSUB 不可用,回退内置渲染', e)
                await engine.setNativeSubtitleEnabled(false)
                const lm2 = engine
                  .streams()
                  .find((x) => x.mediaType === 'subtitle' && x.index === t.index)
                if (lm2 && lastNativeSubIdRef.current !== lm2.id) {
                  await engine.setNativeSubtitleEnabled(true)
                  await engine.selectSubtitle(lm2.id)
                  lastNativeSubIdRef.current = lm2.id
                }
                return
              }
              console.info(
                `[subtitle] track=${t.index} codec=${t.codec} bytes=${raw.length} ` +
                `detect=${detected} events=${cues.length} renderer=JASSUB ` +
                `fonts=${engine.embeddedFonts().length} elapsed=${Math.round(performance.now() - t0)}ms`,
              )
            }
            try {
              await attachText(track)
              setSubError('')
              return
            } catch (e) {
              console.warn(`[subtitle] track=${track.index} 加载失败:`, e instanceof Error ? e.message : e)
            }
            // 请求轨失败 → 其它文本轨兜底(同语言优先,最多 3 条)
            const langOf = (t: SubTrack) => (t.label.match(/\[([^\]]+)\]/)?.[1] ?? '').toLowerCase()
            const wantLang = langOf(track)
            const others = subs
              .filter((t) => t.index !== track.index && !t.isGraphic)
              .sort((a, b) => Number(langOf(b) === wantLang) - Number(langOf(a) === wantLang))
              .slice(0, 3)
            for (const cand of others) {
              try {
                await attachText(cand)
                setSubError(`轨 ${track.index} 不可用,已自动切换到轨 ${cand.index}`)
                console.warn(`[subtitle] 轨 ${track.index} 失败,已回退到轨 ${cand.index}`)
                return
              } catch (e) {
                console.warn(`[subtitle] 备选轨 ${cand.index} 也失败:`, e instanceof Error ? e.message : e)
              }
            }
            setStatus('error')
            setErrorMsg(`字幕轨 ${track.index} 无法加载,且没有可用的备选文本轨`)
            return
          }
          // 原生 mp4 引擎:ASS → VTT 挂 <video> 文本轨
          const raw = await fetchSubTextCached(track)
          const unified = toUnifiedAss(raw, 1280, 720)
          setTrCues(parseAssCues(unified))
          const vtt = assToVtt(unified)
          const ne = engine as unknown as { setTextTrackVtt(v: string, l?: string): void }
          if (typeof ne.setTextTrackVtt === 'function') {
            ne.setTextTrackVtt(vtt, track.label)
            setSubError('')
          } else {
            setSubError('该播放通道暂不支持字幕')
          }
          return
        }
        // 转码通道(HLS):内嵌字幕轨不可用,同样走 Emby 提取
        if (track.isGraphic) {
          setSubError('转码通道不支持图形字幕')
          return
        }
        const vs = engine.streams().find((x) => x.mediaType === 'video')
        const raw = await fetchSubTextCached(track)
        const assText = toUnifiedAss(raw, vs?.width || 1280, vs?.height || 720)
        setTrCues(parseAssCues(assText)) // 文稿面板数据
        const file = new File([assText], `subtitle.${track.codec === 'ass' || track.codec === 'ssa' ? 'ass' : 'srt'}`, {
          type: 'text/plain',
        })
        if (!(engine instanceof Engine) || typeof engine.loadExternalSubtitle !== 'function') {
          setSubError('转码线路暂不支持外挂字幕(可回到原画直连观看字幕)')
          return
        }
        const extId = await (engine as Engine).loadExternalSubtitle({ source: file, lang: track.codec, title: track.label })
        await engine.selectSubtitle(extId)
        setSubError('')
      } catch (e) {
        console.error('字幕加载失败', e)
        setSubError(e instanceof Error ? e.message : String(e))
      }
    },
    [api, itemId, subs],
  )

  // ---------- 引擎事件 ----------
  const handleEngineError = useCallback(
    (err: Error) => {
      console.error('[player] 引擎错误', err)
      const s = srcRef.current
      const ms = mediaSourceRef.current
      if (!s) return
      // 生命周期竞态(load/play 交叠)不是解码失败,libmedia 自己会恢复,不降级
      if (/not loaded|status/i.test(err.message)) return
      // 音频解码失败(TrueHD 等无法本地解码的编码)→ 切 remux:视频 -c copy 仅音频转 AAC
      // 容器打不开(open stream failed):有 remux/转码链就降级(服务器最小参与),
      // 没有(Emby 也解析不了的孤例)→ 明确报错,不黑屏
      if (/open stream failed/i.test(err.message) && !streamFallbackUsedRef.current) {
        streamFallbackUsedRef.current = true
        void switchToRemux().then((ok) => {
          if (!ok) {
            setStatus('error')
            setErrorMsg('该文件的容器结构浏览器无法解析(DirectPlay 失败),且服务器未提供转码链路')
          }
        })
        return
      }
      if (/audio-decoder-failed|cannot open audio|open audio decoder/i.test(err.message)) {
        if (!audioFallbackUsedRef.current) {
          audioFallbackUsedRef.current = true
          void switchToRemux().then((ok) => {
            if (!ok) {
              setStatus('error')
              setErrorMsg('音频编码本机无法解码,且服务器无法转码音频')
            }
          })
        }
        return
      }
      // 原生 <video> 解不动(典型:HEVC-in-MP4 无系统解码)→ 同一 URL 换 libmedia
      // 引擎直连(uhd 同款:MSE 不行还有 wasm 软解),不转码、不降画质
      if (s.kind === 'direct-native' && !fallbackUsedRef.current) {
        fallbackUsedRef.current = true
        forceLibmediaRef.current = true
        setSrc({ ...s })
        return
      }
      // MSE 打不开(编码不支持/remux 失败)→ 记忆该组合,回退 canvas 管线(硬解/软解)
      if (engineRef.current instanceof Engine && engineRef.current.isPreferMSE) {
        memoMseFail(mseKeyRef.current)
        msePreferredRef.current = false
        setPipeline('sw')
        void (async () => {
          const engine = engineRef.current
          if (!(engine instanceof Engine)) return
          await engine.rebuild() // 不带 checkUseMSE 重建 → libmedia 默认选择(canvas 硬解优先)
          await engine.load(s.url, { ext: s.ext })
          await engine.play()
        })()
        return
      }
      // 第一级降级:直连失败 → 纯 wasm 软解重建
      if ((s.kind === 'direct' || s.kind === 'direct-stream') && !engineRef.current?.isWasmOnly) {
        setWasmOnly(true)
        setPipeline('sw')
        void (async () => {
          const engine = engineRef.current
          if (!(engine instanceof Engine)) return
          await engine.downgradeToWasmOnly()
          await engine.load(s.url, { ext: s.ext })
          await engine.play()
        })()
        return
      }
      setStatus('error')
      setErrorMsg(`视频加载失败:${err.message || '引擎错误'}`)
    },
    [],
  )

  const engineHandlers = useMemo(
    () => ({
      onLoading: () => setStatus((st) => (st === 'error' ? st : 'loading')),
      onLoaded: () => {
        setStatus('ready')
        // 时长:MKV 直链的容器时长经常是坏值,优先用 Emby 元数据
        const metaDur = item ? T(item.RunTimeTicks) : 0
        const engineDur = engineRef.current?.durationSec() ?? 0
        setDur(metaDur > 60 ? metaDur : engineDur > 5 ? engineDur : metaDur)
        // 默认关 libmedia 自渲染,等字幕选择逻辑接管
        void engineRef.current?.setNativeSubtitleEnabled(false)
        void engineRef.current?.play().catch(() => {})
      },
      onFirstFrame: () => {
        startedRef.current = true
        // 续播跳转必须在播放真正开始后:MKV 直链播放前 seek 会 demuxer seek failed
        if (!resumeDoneRef.current && item) {
          resumeDoneRef.current = true
          const pos = T(item.UserData?.PlaybackPositionTicks)
          const total = engineRef.current?.durationSec() ?? 0
          if (pos > 15 && (!total || pos < total - 30)) {
            Promise.resolve(engineRef.current?.seek(pos)).catch(() => {})
          }
        }
        // seek 失败重载后的目标定位(首帧定位路径稳定)
        if (pendingSeekRef.current != null) {
          const t = pendingSeekRef.current
          pendingSeekRef.current = null
          Promise.resolve(engineRef.current?.seek(t)).catch(() => {})
        }
      },
      onPlaying: () => {
        setPaused(false)
        reportRef.current.paused = false
      },
      onPaused: () => {
        setPaused(true)
        reportRef.current.paused = true
      },
      onEnded: () => {
        setPaused(true)
        reportRef.current.paused = true
        if (itemId) api.markPlayed(itemId).catch(() => {})
        reportStateRef.current?.('stop')
      },
      onTime: (sec: number) => {
        if (Math.abs(sec - lastTimeRef.current) < 0.1) return
        lastTimeRef.current = sec
        setCur(sec)
      },
      onSeeked: () => {
        lastTimeRef.current = engineRef.current?.currentSec() ?? 0
        setCur(lastTimeRef.current)
      },
      onError: (err: Error) => handleEngineError(err),
      onPipeline: (kind: PipelineKind, reason?: string) => {
        pipelineRef.current = kind
        setPipeline(kind)
        setPipelineReason(reason ?? '')
      },
      onVolumeChange: (v: number) => {
        setVolume(v)
        setMuted(v === 0)
        localStorage.setItem('ewp/volume', String(v))
      },
      onTrackChanged: () => {
        const s = engineRef.current?.streams() ?? []
        setAudioTracks(s.filter((x) => x.mediaType === 'audio').map(buildAudioTrack))
        setSelectedAudioId(engineRef.current?.selectedAudioId() ?? null)
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, itemId, item],
  )

  // ---------- 初始化:取媒体信息,尽量直连 ----------
  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    setStatus('loading')
    setErrorMsg('')
    setWasmOnly(false)
    setPipeline('unknown')
    startupAttemptsRef.current = 0
    recoveryRef.current = { count: 0, lastAt: 0 }
    resumeDoneRef.current = false
    fallbackUsedRef.current = false
    forceLibmediaRef.current = false
    audioFallbackUsedRef.current = false
    streamFallbackUsedRef.current = false
    setSrc(null)

    ;(async () => {
      try {
        const it = await api.item(itemId)
        if (cancelled) return
        setItem(it)
        // 可播放类型白名单:合集/文件夹等条目没有媒体流,Emby 的 PlaybackInfo 会 500
        const playable = ['Movie', 'Episode', 'Video', 'MusicVideo']
        if (!playable.includes(it.Type)) {
          navigate(`/item/${it.Id}`, { replace: true })
          return
        }

        const info = await api.playbackInfo(itemId, profile)
        if (cancelled) return
        playSessionRef.current = info.PlaySessionId ?? null
        const ms: MediaSource | undefined = info.MediaSources?.[0]
        if (!ms) {
          setStatus('error')
          setErrorMsg('服务器没有返回可用的媒体源')
          return
        }
        setMediaSource(ms)
        mediaSourceRef.current = ms
        const streams = ms.MediaStreams ?? []

        const subStreams = streams.filter((s) => s.Type === 'Subtitle')
        setSubs(subStreams.map((s) => buildSubTrack(s, itemId, ms.Id)))

        const container = (ms.Container ?? 'mp4').split(',')[0]
        const canDirect = ms.SupportsDirectPlay || ms.SupportsDirectStream

        // 纯直连策略(uhd 同款):永远原样直连,不探测硬解、不自动降画质转码。
        // 4K HEVC 走 wasm 多线程软解,桌面 CPU 实时可跑(uhd 面板实测 3840×1598 软解实时 25fps);
        // 真跑不动由播放中的停滞自愈兜底,而不是开播前偷换 720P
        const vs = streams.find((s) => s.Type === 'Video')
        const as = streams.find((s) => s.Type === 'Audio')
        // MSE 优先(最低 CPU):该"视频编码+音轨编码+分辨率档"组合上次 MSE 失败过则跳过
        const mseKey = `${(vs?.Codec ?? '?').toLowerCase()}:${(as?.Codec ?? '?').toLowerCase()}:${vs?.Height && vs.Height > 1080 ? 'big' : 'norm'}`
        msePreferredRef.current = Boolean(canDirect && !mseFailMemo().has(mseKey))
        mseKeyRef.current = mseKey

        // 音频兜底(P0-1):视频永远直连;音频本地解不了(TrueHD 等,无 wasm 解码器)
        // 时整条切 DirectStreamUrl/TranscodingUrl——服务器视频 -c copy 仅音频转 AAC,
        // 真正做到"视频不转码、音频最小处理"。有 remux 链就用,没有则原始直连+运行时兜底(P0-2)
        hasAudioStreamRef.current = !!as
        const audioLocal = isAudioLocallyDecodable(as?.Codec, supportsAc3)
        const remuxUrl = (ms.DirectStreamUrl ?? ms.TranscodingUrl ?? '').trim()
        if (canDirect && !audioLocal && remuxUrl) {
          const url = remuxUrl.startsWith('http') ? new URL(remuxUrl).pathname + new URL(remuxUrl).search : remuxUrl
          const ext = (url.match(/\.(mkv|ts|m3u8|mp4)(?:$|\?)/i)?.[1] ?? 'mkv').toLowerCase()
          setSrc({
            url,
            kind: 'direct-stream',
            ext,
            audioTranscoded: true,
          })
        } else if (canDirect) {
          // mp4(H264/AAC 等浏览器原生支持的组合)→ 原生 <video> 渐进直连:
          // 零 JS 解码开销、seek 由浏览器 Range 处理(绝无 demuxer seek 失败)
          const nativeDirect = ['mp4', 'm4v'].includes(container)
          setSrc({
            url: api.mediaUrl(`/emby/Videos/${itemId}/stream.${container}`, {
              Static: true,
              MediaSourceId: ms.Id,
              PlaySessionId: info.PlaySessionId,
            }),
            kind: nativeDirect ? 'direct-native' : 'direct',
            ext: container,
          })
        } else {
          // 服务器拒绝直连 → 转码是唯一出路;拿不到 TranscodingUrl 才报错
          let tUrl = ms.TranscodingUrl
          if (!tUrl) {
            const tr = await api.playbackInfo(itemId, profile, 0, true)
            if (cancelled) return
            tUrl = tr.MediaSources?.[0]?.TranscodingUrl
          }
          if (tUrl) {
            const url = tUrl.startsWith('http')
              ? new URL(tUrl).pathname + new URL(tUrl).search
              : tUrl
            setSrc({ url, kind: 'transcode', ext: tUrl.includes('.m3u8') ? 'm3u8' : undefined })
          } else {
            setStatus('error')
            setErrorMsg('服务器未允许该媒体直连播放,且拿不到转码地址')
            return
          }
        }

        // 自动选字幕:默认轨 > 中文轨 > 关闭(PGS 也默认开启,libmedia 能画)
        const def =
          subStreams.find((s) => s.IsDefault) ??
          subStreams.find((s) => s.Language?.toLowerCase().startsWith('zh'))
        setActiveSub(def?.Index ?? null)
        activeSubRef.current = def?.Index ?? null
        // 起播前并行预取:字幕提取请求 / JASSUB 的 wasm 与字体,全部与视频缓冲重叠,
        // 消除"起播后字幕晚 2 秒才出现"的串行等待
        if (def) {
          const defTrack = buildSubTrack(def, itemId, ms.Id)
          if (!defTrack.isGraphic) {
            void fetchSubtitleText(api, defTrack, itemId, ms.Id)
              .then((text) => subTextCache.set(subTextKey(itemId, ms.Id, def.Index), text))
              .catch(() => {})
          }
        }
        {
          const base = new URL(import.meta.env.BASE_URL, location.href).href
          void fetch(new URL('jassub/jassub-worker.wasm', base).href, { priority: 'low' } as RequestInit).catch(() => {})
          void fetch(new URL('jassub/jassub-worker-modern.wasm', base).href, { priority: 'low' } as RequestInit).catch(() => {})
          void loadFontManifest()
            .then((m) => toJassubFontConfig(m))
            .then((cfg) => {
              for (const url of cfg.fontUrls) void fetch(url, { priority: 'low' } as RequestInit).catch(() => {})
            })
            .catch(() => {})
        }
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setErrorMsg(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [api, itemId, navigate, profile, sessionId, switchToRemux])

  /** 启动看门狗:load 挂起(如 MSE 打不开且不抛错)时按链降级 */
  const handleStartupFailure = useCallback(() => {
    const s = srcRef.current
    if (!s) return
    startupAttemptsRef.current += 1
    console.warn(`[player] 启动超时,第 ${startupAttemptsRef.current} 次降级`)
    if (startupAttemptsRef.current >= 3) {
      setStatus('error')
      setErrorMsg('视频启动失败:已尝试全部解码通道(可稍后重试或换用其他线路)')
      return
    }
    // 原画直连启动失败:记忆条目,之后详情弹窗默认推荐转码
    if (itemId) {
      try {
        const bad = new Set(JSON.parse(localStorage.getItem('ewp/direct-bad') ?? '[]'))
        bad.add(itemId)
        localStorage.setItem('ewp/direct-bad', JSON.stringify([...bad]))
      } catch { /* ignore */ }
    }
    const engine = engineRef.current
    if (engine?.isPreferMSE) {
      memoMseFail(mseKeyRef.current)
      msePreferredRef.current = false
      setSrc({ ...s })
      return
    }
    if ((s.kind === 'direct' || s.kind === 'direct-stream') && !engine?.isWasmOnly) {
      setWasmOnly(true)
      setPipeline('sw')
      setSrc({ ...s })
      return
    }
    setStatus('error')
    setErrorMsg('视频启动失败:所有直连解码通道均未能就绪(点击「重试」再试一次)')
  }, [])

  // ---------- 引擎挂载与源切换 ----------
  useEffect(() => {
    if (!src || !surfaceRef.current) return
    const token = ++loadTokenRef.current
    srcRef.current = src
    const container = (srcRef.current?.ext ?? '').toLowerCase()
    const srcContainer = (srcRef.current?.ext ?? '').toLowerCase()
    const useNative =
      (srcContainer === 'm3u8' || srcContainer === 'mp4' || srcContainer === 'm4v') &&
      !forceLibmediaRef.current
    const engine: Engine | NativeEngine = useNative
      ? new NativeEngine(surfaceRef.current)
      : new Engine(surfaceRef.current, {
          preferMSE: msePreferredRef.current,
          // 实测部分 MP4 在 libmedia 下有主线程冻结风险 → MP4 一律原生
          noWorker: true,
          // libmedia demuxer 对部分 AAC 轨会填出无效声道数(-1)导致 wasm 解码器
          // open 失败(-28)卡死起播,带上 Emby 元数据里的真实声道数供引擎修复
          audioChannelsHint:
            mediaSourceRef.current?.MediaStreams?.find((x) => x.Type === 'Audio')?.Channels ?? 0,
          // 默认音轨本地解不了(TrueHD 等)→ 选同文件里可解的备用音轨(AC3 等)
          audioStreamIndexHint: pickPreferredAudioIndex(
            (mediaSourceRef.current?.MediaStreams ?? [])
              .filter((x) => x.Type === 'Audio')
              .map((x) => ({ index: x.Index, codec: x.Codec, channels: x.Channels, isDefault: x.IsDefault })),
            supportsAc3,
          ),
        })
    ;(window as any).__ewp_engine = engine // 诊断钩子(不暴露敏感数据)
    engineRef.current = engine
    ;(async () => {
      try {
        await engine.create(engineHandlers as never)
        if (token !== loadTokenRef.current) return
        if (engine instanceof NativeEngine) {
          await engine.load(src.url, { progressive: src.kind === 'direct-native' })
        } else {
          // uhd 式首段预载:按内容码率估 20 秒的量(8MB~64MB),减少小 Range 分片
          const ms0 = mediaSourceRef.current
          const v0 = ms0?.MediaStreams?.find((x) => x.Type === 'Video')
          const br = v0?.BitRate ?? 0
          const preload = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.round((br / 8) * 20)))
          // 大文件(原盘/REMUX,流多)demuxer 探测慢,默认 3 秒预算会 open stream failed(-2),放宽到 15 秒
        await engine.load(src.url, { ext: src.ext, preloadBytes: preload, maxProbeDuration: 15 })
        }
        // play() 只在 onLoaded 回调里调,这里重复调会撞状态机(fatal: status not loaded)
      } catch (e) {
        if (token !== loadTokenRef.current) return
        handleEngineError(e instanceof Error ? e : new Error(String(e)))
      }
    })()

    // 启动看门狗:onLoaded 22 秒未触发 → load 挂起 → 降级链
    ;(window as any).__ewp_dbg = []
    const wd = setTimeout(() => {
      if (token !== loadTokenRef.current) return
      if (statusRef.current !== 'ready') handleStartupFailure()
    }, 15_000)

    return () => {
      loadTokenRef.current++
      clearTimeout(wd)
      // 字幕宿主必须先于引擎销毁:旧实例不能再持有已销毁的渲染面(历史竞态根源)
      void getJassub().detach()
      lastNativeSubIdRef.current = null
      engineRef.current?.destroy().catch(() => {})
      if (engineRef.current === engine) engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  // 卸载时兜底销毁引擎
  useEffect(() => {
    return () => {
      loadTokenRef.current++
      engineRef.current?.destroy().catch(() => {})
      engineRef.current = null
    }
  }, [])

  // ---------- 字幕选择生效 ----------
  useEffect(() => {
    if (status !== 'ready') return
    void applySubtitle(activeSub)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSub, status])

  // 渲染面尺寸 = 视频显示矩形:canvas 管线下 libmedia 在画布内部按宽高比加黑边,
  // 若画布被 CSS 拉成窗口大小,DOM 字幕层(按容器坐标定位)会和画面错位/被裁。
  // 让渲染面精确贴合视频显示区域并居中,字幕层坐标自然对齐。
  const fitSurface = useCallback(() => {
    const el = surfaceRef.current
    const page = shellRef.current
    if (!el || !page) return
    const vs = engineRef.current?.streams().find((x) => x.mediaType === 'video')
    const vw = vs?.width || 0
    const vh = vs?.height || 0
    const W = page.clientWidth
    const H = page.clientHeight
    if (!vw || !vh || !W || !H) {
      el.style.width = ''
      el.style.height = ''
      el.style.left = '0px'
      el.style.top = '0px'
      return
    }
    const ar = vw / vh
    let w = W
    let h = W / ar
    if (h > H) { h = H; w = H * ar }
    el.style.width = `${Math.round(w)}px`
    el.style.height = `${Math.round(h)}px`
    el.style.left = `${Math.round((W - w) / 2)}px`
    el.style.top = `${Math.round((H - h) / 2)}px`
  }, [])

  useEffect(() => {
    if (status !== 'ready') return
    fitSurface()
    window.addEventListener('resize', fitSurface)
    return () => window.removeEventListener('resize', fitSurface)
  }, [status, fitSurface])

  useEffect(() => {
    const onFs = () => setTimeout(fitSurface, 100)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [fitSurface])

  // ---------- 进度上报 ----------
  const reportState = useCallback(
    (event: 'progress' | 'stop') => {
      const engine = engineRef.current
      const ms = mediaSourceRef.current
      if (!engine || !itemId || !ms) return
      const audioIdx = audioTracks.find((a) => a.id === selectedAudioId)?.index
      const body = {
        ItemId: itemId,
        MediaSourceId: ms.Id,
        PlaySessionId: playSessionRef.current,
        PositionTicks: Math.round(engine.currentSec() * 10_000_000),
        CanSeek: true,
        IsPaused: reportRef.current.paused,
        IsMuted: muted,
        PlayMethod: srcRef.current?.kind === 'direct' ? 'DirectPlay' : 'Transcode',
        AudioStreamIndex: audioIdx,
        SubtitleStreamIndex: activeSubRef.current ?? undefined,
      }
      const path = event === 'progress' ? '/emby/Sessions/Playing/Progress' : '/emby/Sessions/Playing/Stopped'
      if (event === 'stop') {
        fetch(api.url(path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
        }).catch(() => {})
      } else {
        api.reportProgress(body).catch(() => {})
      }
    },
    [api, itemId, muted, audioTracks, selectedAudioId],
  )

  useEffect(() => {
    reportStateRef.current = reportState
  }, [reportState])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    if (status !== 'ready') return
    const timer = setInterval(() => reportState('progress'), 10_000)
    return () => clearInterval(timer)
  }, [status, reportState])

  useEffect(() => {
    return () => {
      reportState('stop')
    }
  }, [reportState])

  // ---------- 卡顿看门狗:软解追不上帧(时间几乎不前进)时,自动切服务器转码 ----------
  useEffect(() => {
    if (!src || src.kind !== 'direct') return
    stallRef.current = { lastSec: 0, lastTs: 0, failures: 0 }
    const timer = setInterval(() => {
      const engine = engineRef.current
      if (!engine || userPausedRef.current || status !== 'ready') return
      const now = Date.now()
      const curSec = engine.currentSec()
      const { lastSec, lastTs, failures } = stallRef.current
      if (lastTs && curSec - lastSec < 1 && now - lastTs > 4000) {
        // 纯直连策略下不降画质:卡顿只反映网络/解码状态,由加载圈表达
        stallRef.current = { lastSec: curSec, lastTs: now, failures: failures + 1 }
        return
      }
      stallRef.current = { lastSec: curSec, lastTs: now, failures: 0 }
    }, 4000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, status])

  // ---------- 控制栏交互 ----------
  const togglePlay = useCallback(() => {
    void engineRef.current?.togglePlay()
    // 用户意图暂停/恢复(引擎 PAUSED 事件在 canvas 管线不可靠,看门狗以此区分主动暂停与卡死)
    userPausedRef.current = !userPausedRef.current
    // 乐观更新 UI,不等引擎事件
    setPaused(userPausedRef.current)
    reportRef.current.paused = userPausedRef.current
    if (!userPausedRef.current) resumedAtRef.current = Date.now()
  }, [])

  const seekTo = useCallback((sec: number) => {
    const engine = engineRef.current
    if (!engine) return
    const total = engine.durationSec()
    const target = Math.max(0, total ? Math.min(total, sec) : sec)
    // uhd 同款提前量:关键帧扫描只会向后落点,带 750ms lead 保证落点不越过目标
    const LEAD = 0.75
    const seekAt = Math.max(0, target - LEAD)
    seekVerifyRef.current = { target, at: Date.now(), reloading: false }
    setSeekLoading(true)
    Promise.resolve(engine.seek(seekAt)).catch(() => {})
  }, [])

  /** 用户拖动/按键跳转:先尝试常规 seek,6 秒内时间没跟上 → 整机重载到目标位置
   *  (部分 MKV 直链没有 seek 索引,demuxer seek 失败会停摆音视频管线) */
  const seekBy = useCallback((delta: number) => {
    const engine = engineRef.current
    if (!engine) return
    seekTo(engine.currentSec() + delta)
  }, [seekTo])

  /** seek 失败兜底:整机重载,首帧后定位到目标(该路径已验证稳定) */
  const reloadEngineAt = useCallback(async (target: number) => {
    const s = srcRef.current
    const surface = surfaceRef.current
    if (!s || !surface) return
    loadTokenRef.current++
    engineRef.current?.destroy().catch(() => {})
    const engine = new Engine(surface, { preferMSE: msePreferredRef.current })
    ;(window as any).__ewp_engine = engine
    engineRef.current = engine
    resumeDoneRef.current = true
    pendingSeekRef.current = target
    try {
      await engine.create(engineHandlers)
      await engine.load(s.url, { ext: s.ext })
      await engine.play()
    } catch (e) {
      handleEngineError(e instanceof Error ? e : new Error(String(e)))
    }
  }, [engineHandlers, handleEngineError])

  // UI 时钟:每秒读引擎时钟驱动进度显示,并用"时间在走"反向纠正播放状态
  // (canvas 管线下 PLAYING/PLAYED 事件不保证触发,不能只依赖事件)
  useEffect(() => {
    if (status !== 'ready') return
    const timer = setInterval(() => {
      const engine = engineRef.current
      if (!engine) return
      const sec = engine.currentSec()
      if (sec > 0 && sec > lastAdvanceRef.current) {
        lastAdvanceRef.current = sec
        if (reportRef.current.paused) {
          reportRef.current.paused = false
          setPaused(false)
        }
      }
      if (Math.abs(sec - lastTimeRef.current) >= 0.5) {
        lastTimeRef.current = sec
        setCur(sec)
      }
      const buf = engine.bufferedSec()
      setBufferedPct(dur > 0 && buf ? Math.min(100, (buf / dur) * 100) : 0)

      // seek 校验:时间跟上 → 完成;6 秒没跟上 → 整机重载兜底
      const sv = seekVerifyRef.current
      if (sv && !sv.reloading) {
        if (Math.abs(sec - sv.target) <= 4) {
          seekVerifyRef.current = null
          setSeekLoading(false)
        } else if (Date.now() - sv.at > 6000) {
          sv.reloading = true
          console.warn('[player] seek 6 秒未生效,重载引擎到目标位置', sv.target)
          void reloadEngineAt(sv.target).then(() => {
            seekVerifyRef.current = null
            setSeekLoading(false)
          })
        }
      }

      // 卡顿圈:时间 3 秒未走 → 真停滞(与上一拍的 sec 比较,不能用刚更新的 lastAdvance)
      // 恢复播放后 10 秒宽限:重新缓冲属于正常,不判定停滞
      const inResumeGrace = resumedAtRef.current > 0 && Date.now() - resumedAtRef.current < 10_000
      const isStalled = !seekVerifyRef.current && !userPausedRef.current &&
        sec > 0 && sec <= prevSecRef.current + 0.01 && !inResumeGrace
      if (isStalled) {
        stallUiCount.current += 1
      } else {
        stallUiCount.current = 0
      }
      setStalledUi(!userPausedRef.current && !seekVerifyRef.current && stallUiCount.current >= 3)
      prevSecRef.current = sec
      if ((window as any).__ewp_dbg) {
        (window as any).__ewp_dbg.push({
          t: Date.now() % 100000,
          sec: Math.round(sec * 10) / 10,
          lastAdv: Math.round(lastAdvanceRef.current * 10) / 10,
          count: stallUiCount.current,
          stalled: stalledUi,
          userPaused: userPausedRef.current,
          status,
        })
      }

      // 停滞自愈:libmedia 管线停摆(demux 队列清空后不再出数据)时,
      // 整机重载并从当前位置续播——这是 demuxer seek/恢复失败的唯一可靠出路
      if (
        isStalled && stallUiCount.current >= 6 &&
        !(engineRef.current instanceof NativeEngine) && status === 'ready'
      ) {
        const rec = recoveryRef.current
        const nowTs = Date.now()
        if (rec.count < 2 && nowTs - rec.lastAt > 20_000) {
          recoveryRef.current = { count: rec.count + 1, lastAt: nowTs }
          const target = Math.max(sec - 1, 0)
          console.warn(`[player] 播放持续停滞,自动重载续播 @ ${target.toFixed(1)}s(第 ${rec.count + 1} 次)`)
          setSeekLoading(true)
          void reloadEngineAt(target).then(() => setSeekLoading(false))
        }
      }

      // 音频停滞看门狗:seek 后 libmedia 渲染线程可能没有恢复——视频时间照常前进,
      // 上面的停滞检测(基于视频时钟)永远抓不到"音频消失"。改用 libmedia 的
      // audioRenderFramerate/audioDecodeFramerate 判定:播放中两者持续为 0:
      //   4 秒 → play() 重新拉起渲染线程(pause/resume 同款机制);
      //   再 4 秒仍 0 → 整机重载(音频必回)。重载与恢复都有次数/时间限速。
      if (
        hasAudioStreamRef.current && engineRef.current instanceof Engine &&
        !userPausedRef.current && !seekVerifyRef.current && !inResumeGrace &&
        status === 'ready' && !engineRef.current.isPaused
      ) {
        const st = engineRef.current.statsSnapshot()
        const audioAlive = !st || st.audioRenderFps > 0 || st.audioDecodeFps > 0
        if (audioAlive) {
          audioStallRef.current = 0
        } else {
          audioStallRef.current += 1
          const nowTs = Date.now()
          const arec = audioReloadRef.current
          if (audioStallRef.current === 4) {
            console.warn('[player] 音频渲染停滞,play() 恢复渲染线程')
            audioStallRef.current = 0
            resumedAtRef.current = Date.now()
            void engineRef.current.resume()
          } else if (audioStallRef.current >= 8 && arec.count < 2 && nowTs - arec.lastAt > 60_000) {
            audioReloadRef.current = { count: arec.count + 1, lastAt: nowTs }
            audioStallRef.current = 0
            const target = Math.max(sec - 1, 0)
            console.warn(`[player] 音频恢复无效,整机重载 @ ${target.toFixed(1)}s`)
            setSeekLoading(true)
            void reloadEngineAt(target).then(() => setSeekLoading(false))
          }
        }
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [status, reloadEngineAt])


  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen()
    else shellRef.current?.requestFullscreen?.()
  }, [])

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          seekBy(e.shiftKey ? -60 : -10)
          break
        case 'ArrowRight':
          seekBy(e.shiftKey ? 60 : 10)
          break
        case 'ArrowUp': {
          const v = Math.min(1, (muted ? 0 : volume) + 0.05)
          engineRef.current?.setVolume(v)
          setVolume(v)
          setMuted(false)
          break
        }
        case 'ArrowDown': {
          const v = Math.max(0, volume - 0.05)
          engineRef.current?.setVolume(v)
          setVolume(v)
          break
        }
        case 'f':
          toggleFullscreen()
          break
        case 'm': {
          const v = muted ? Number(localStorage.getItem('ewp/volume') ?? 1) || 1 : 0
          engineRef.current?.setVolume(v)
          setMuted(!muted)
          setVolume(v || volume)
          break
        }
        case 'Escape':
          if (!document.fullscreenElement) navigate(-1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekBy, toggleFullscreen, navigate, volume, muted])

  // 自动隐藏控制栏
  useEffect(() => {
    let timer = 0
    const wake = () => {
      setShowControls(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!paused) setShowControls(false)
      }, 3000)
    }
    wake()
    const el = shellRef.current
    el?.addEventListener('mousemove', wake)
    return () => {
      window.clearTimeout(timer)
      el?.removeEventListener('mousemove', wake)
    }
  }, [status, paused])

  const fmt = (s: number) => {
    if (!isFinite(s)) return '0:00'
    const t = Math.floor(s)
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const sec = t % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`
  }

  const playedPct = dur > 0 ? ((seekPreview !== null ? (seekPreview / 1000) * dur : cur) / dur) * 100 : 0

  const badgeText = (() => {
    if (srcRef.current?.kind === 'direct-stream') return '直连 · 音频转码'
    if (srcRef.current?.kind === 'transcode') return '服务器转码'
    if (pipeline === 'mse') return wasmOnly ? '直连 · MSE' : '直连 · 原生 HDR'
    if (pipeline === 'hw') return '直连 · 硬解'
    if (pipeline === 'sw') return '直连 · 软解'
    return '直连'
  })()

  // 右下角画质徽标(来自当前视频流)
  const qualityInfo = (() => {
    const vs = mediaSource?.MediaStreams?.find((x) => x.Type === 'Video')
    if (!vs) return null
    const height = vs.Height ?? 0
    const res = height >= 4320 ? '4320P' : height >= 2160 ? '2160P' : height >= 1440 ? '1440P' : height >= 1080 ? '1080P' : height >= 720 ? '720P' : height ? `${height}P` : ''
    const transfer = (vs.ColorTransfer ?? '').toLowerCase()
    const color = transfer.includes('2084') ? 'HDR10' : transfer.includes('arib') ? 'HLG' : transfer.includes('hlg') ? 'HLG' : transfer ? 'SDR' : ''
    const codec = (vs.Codec ?? '').toUpperCase()
    const bitrate = vs.BitRate ? `${(vs.BitRate / 1_000_000).toFixed(1)} Mbps` : ''
    const pills = [res, color, codec, bitrate].filter(Boolean)
    return { line: pills.slice(0, 3).join(' '), pills }
  })()

  if (status === 'error') {
    return (
      <div className="player-page">
        <div className="player-error">
          <h2>无法播放</h2>
          <p>{errorMsg}</p>
          <div className="player-error-actions">
            <button className="btn-primary" onClick={() => window.location.reload()}>重试</button>
            <button className="btn-ghost" onClick={() => navigate(-1)}>返回</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={shellRef}
      className={`player-page ${showControls ? '' : 'hide-cursor'}`}
      onClick={() => setOpenMenu(null)}
    >
      {/* libmedia 渲染面(video 或 canvas 都挂在这里) */}
      <div className="player-surface" ref={surfaceRef} onClick={togglePlay} onDoubleClick={toggleFullscreen} />

      {/* 缓冲/加载圈(全屏居中) */}
      {(stalledUi || seekLoading || (status === 'loading' && !startedRef.current)) && (
        <div className="player-spinner"><div className="spinner-ring" /></div>
      )}

      {/* 顶部:返回胶囊 + 集数标题(UHD 式) */}
      <div className={`player-top ${showControls ? '' : 'hidden'}`}>
        <button className="back-pill" onClick={() => navigate(-1)}>← 返回</button>
        <span className="player-title">
          {item?.Type === 'Episode' && item.SeriesName
            ? `${item.SeriesName} 第${item.ParentIndexNumber ?? '?'}季 第${item.IndexNumber ?? '?'}集 ${item.Name}`
            : item?.Name}
        </span>
        {hwHint && <span className="hw-hint">{hwHint}</span>}
      </div>

      {status === 'loading' && <div className="player-loading">加载中…</div>}

      {/* 中央大播放键(暂停时,UHD 式):继续播放 / 从头播放 */}
      {paused && status === 'ready' && (
        <div className="center-play" onClick={togglePlay}>
          <div className="big-play"><svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
          <div className="big-play-label">{cur > 10 ? '继续播放' : '开始播放'}</div>
          {cur > 10 && (
            <button
              className="from-start"
              onClick={(e) => { e.stopPropagation(); seekTo(0); userPausedRef.current = false; }}
            >
              ⟲ 从头播放
            </button>
          )}
        </div>
      )}

      {/* 底部信息条(左:剧集徽标/时长/标题;右:画质) */}
      <div className={`player-bottominfo ${showControls ? '' : 'hidden'}`}>
        <div className="bi-left">
          {item?.Type === 'Episode' && <span className="bi-badge">剧集</span>}
          {item?.Type === 'Movie' && <span className="bi-badge">电影</span>}
          {dur > 0 && <span className="bi-badge dim">{fmt(dur)}</span>}
          <span className="bi-title">{item?.Name}</span>
        </div>
        {qualityInfo && (
          <div className="bi-right">
            <div className="quality-line">{qualityInfo.line}</div>
            <div className="quality-pills">
              {qualityInfo.pills.map((q, i) => <span key={i} className={i <= 2 ? 'pill strong' : 'pill'}>{q}</span>)}
            </div>
          </div>
        )}
      </div>

      {/* 播放链路诊断面板 */}
      {openMenu === 'diag' && diag && (
        <div className="diag-panel" onClick={(e) => e.stopPropagation()}>
          <div className="diag-header">
            <span>播放链路</span>
            <button className="diag-close" onClick={() => setOpenMenu(null)}>×</button>
          </div>
          <div className="diag-body">
            <div className="diag-section">
              <div className="diag-ok">✓ 链路正常 · {badgeText}</div>
            </div>

            <div className="diag-section">
              <h4>源</h4>
              <div className="diag-line">{(srcRef.current?.ext ?? '?').toUpperCase()} 容器 · {trackCount} 条轨道</div>
              <div className="diag-line dim">
                视频 {videoCount} · 音频 {audioCount} · 字幕 {subtitleCount}
              </div>
            </div>

            {diag.stats && (
              <div className="diag-section">
                <h4>网络</h4>
                <div className="diag-line">
                  {diag.rxMbps !== null && diag.rxMbps > 0
                    ? `${diag.rxMbps.toFixed(1)} Mbps`
                    : `${(diag.stats.videoBitrateKbps / 1000).toFixed(1)} Mbps`}
                  <span className="dim"> · 音频 {diag.stats.audioBitrateKbps} kbps</span>
                </div>
                <div className="diag-line dim">
                  丢帧 {diag.stats.videoDropFrames} · 关键帧间隔 {diag.stats.keyFrameInterval || '—'}
                </div>
              </div>
            )}

            <div className="diag-section">
              <h4>解码器</h4>
              {engineIsNative ? (
                <div className="diag-line">浏览器原生解码(零 CPU 开销)</div>
              ) : diag.decoder ? (
                <>
                  <div className="diag-line">
                    {diag.decoder.codec} · {diag.decoder.width}×{diag.decoder.height}
                  </div>
                  <div className="diag-line">
                    {diag.decoder.hardware ? '硬件解码' : '软件解码(wasm)'}
                    <span className="dim"> · 实时 {diag.decoder.framerate} fps</span>
                  </div>
                </>
              ) : (
                <div className="diag-line dim">{pipeline === 'mse' ? '浏览器原生解码(MSE)' : '—'}</div>
              )}
              <div className="diag-line dim">多线程 {globalThis.crossOriginIsolated ? '已启用' : '未启用'}</div>
            </div>

            <div className="diag-section">
              <h4>渲染</h4>
              <div className="diag-line">{pipeline === 'mse' ? '原生 video 画面' : '播放器自渲染画面'}</div>
              <div className="diag-line">字幕引擎:libmedia 内置</div>
            </div>

            <div className="diag-section">
              <h4>轨道({trackCount})</h4>
              {(diag.streams.length > 0 ? diag.streams.map((s) => {
                const isSel =
                  (s.mediaType === 'audio' && s.id === diag.selected.audio) ||
                  (s.mediaType === 'subtitle' && s.id === diag.selected.subtitle) ||
                  (s.mediaType === 'video' && s.id === diag.selected.video)
                const label = `#${s.index} ${{ video: '视频', audio: '音频', subtitle: '字幕' }[s.mediaType]} ${s.codec}`
                const detail = [s.width ? `${s.width}×${s.height}` : '', s.channels ? `${s.channels}ch` : '', s.sampleRate ? `${Math.round(s.sampleRate / 1000)}kHz` : '', s.language || ''].filter(Boolean).join(' · ')
                const onClick = async () => {
                  if (s.mediaType === 'audio') { await engineRef.current?.selectAudio(s.id); setSelectedAudioId(s.id) }
                  else if (s.mediaType === 'subtitle') setActiveSub(s.index)
                  else if (engineRef.current instanceof Engine) await engineRef.current.selectVideo(s.id)
                }
                return { key: `lm${s.id}`, label, detail, sel: isSel, clickable: true, onClick }
              }) : embyTracks.map((m) => ({
                key: `em${m.Index}`,
                label: `#${m.Index} ${{ Video: '视频', Audio: '音频', Subtitle: '字幕' }[m.Type as 'Video' | 'Audio' | 'Subtitle']} ${(m.Codec ?? '').toUpperCase()}`,
                detail: [m.Height ? `${m.Width}×${m.Height}` : '', m.BitRate ? `${Math.round(m.BitRate / 1000)} kbps` : '', m.Language || ''].filter(Boolean).join(' · '),
                sel: false,
                clickable: false,
                onClick: undefined as unknown as () => void,
              }))).map((row) => (
                row.clickable ? (
                  <button key={row.key} className={`diag-track ${row.sel ? 'active' : ''}`} onClick={row.onClick}>
                    <span className="diag-track-marker">{row.sel ? '▶' : '·'}</span>
                    <span className="diag-track-label">{row.label}</span>
                    <span className="diag-track-detail">{row.detail}</span>
                  </button>
                ) : (
                  <div key={row.key} className="diag-track">
                    <span className="diag-track-marker">{row.sel ? '▶' : '·'}</span>
                    <span className="diag-track-label">{row.label}</span>
                    <span className="diag-track-detail">{row.detail}</span>
                  </div>
                )
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 字幕文稿面板(参照 uhdnow-subtitle-extractor) */}
      {trOpen && (
        <div className="tr-panel" onClick={(e) => e.stopPropagation()}>
          <div className="tr-header">
            <span className="tr-title">字幕文稿</span>
            <span className="tr-count">{trCues.length} 条</span>
            <button className="tr-close" onClick={() => setTrOpen(false)}>×</button>
          </div>
          <div className="tr-toolbar">
            <input
              className="tr-search"
              value={trQuery}
              onChange={(e) => setTrQuery(e.target.value)}
              placeholder="搜索字幕…"
            />
            <button
              className={`tr-toggle ${trFollow ? 'on' : ''}`}
              onClick={() => { const v = !trFollow; setTrFollow(v); localStorage.setItem('ewp/trfollow', v ? '1' : '0') }}
              title="自动跟随播放滚动"
            >
              跟随
            </button>
          </div>
          <div className="tr-list" ref={trListRef}>
            {trCues.length === 0 && <div className="tr-empty">当前字幕轨没有可显示的文本</div>}
            {trCues
              .map((c, i) => ({ c, i }))
              .filter(({ c }) => !trQuery || c.text.includes(trQuery))
              .map(({ c, i }) => (
                <div
                  key={i}
                  data-idx={i}
                  className={`tr-cue ${i === trCurIdx ? 'current' : ''}`}
                  onClick={() => seekTo(Math.max(0, c.start - 0.475))}
                  title="点击跳到这句(句首前 0.475 秒)"
                >
                  <span className="tr-cue-time">{fmt(c.start)}</span>
                  <span className="tr-cue-text">{c.text}</span>
                </div>
              ))}
            {trCues.length > 0 && trQuery && !trCues.some((c) => c.text.includes(trQuery)) && (
              <div className="tr-empty">没有匹配「{trQuery}」的字幕</div>
            )}
          </div>
          <div className="tr-footer">
            <button className="tr-btn" onClick={() => {
              const text = trCues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`).join('\n\n')
              navigator.clipboard?.writeText(text).catch(() => {})
            }}>
              复制全文
            </button>
            <button className="tr-btn" onClick={() => {
              const blob = new Blob([cuesToSrt(trCues)], { type: 'text/plain' })
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = `${item?.Name ?? 'subtitles'}.srt`
              a.click()
              URL.revokeObjectURL(a.href)
            }}>
              导出 SRT
            </button>
            <button className="tr-btn" onClick={() => {
              const text = trCues.map((c) => c.text).join('\n')
              navigator.clipboard?.writeText(text).catch(() => {})
            }}>
              复制纯文本
            </button>
          </div>
        </div>
      )}

      {/* 底部控制栏(UHD 极简) */}
      <div className={`player-controls ${showControls ? '' : 'hidden'}`}>
        <div className="seek-bar">
          <input
            type="range"
            min={0}
            max={1000}
            value={seekPreview !== null ? seekPreview : dur > 0 ? Math.min(1000, (cur / dur) * 1000) : 0}
            onChange={(e) => {
              if (dur > 0) setSeekPreview(Number(e.target.value))
            }}
            onPointerUp={(e) => {
              if (seekPreview !== null && dur > 0) seekTo((seekPreview / 1000) * dur)
              setSeekPreview(null)
            }}
            onKeyUp={(e) => {
              if (seekPreview !== null && dur > 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                seekTo((seekPreview / 1000) * dur)
                setSeekPreview(null)
              }
            }}
            style={{
              background: `linear-gradient(to right, #ff4d94 0%, #ff4d94 ${playedPct}%, rgba(255,255,255,0.55) ${playedPct}%, rgba(255,255,255,0.55) ${bufferedPct}%, rgba(255,255,255,0.18) ${bufferedPct}%)`,
            }}
          />
        </div>

        <div className="ctrl-row">
          <CtrlIcon name="back10" title="后退 10 秒" onClick={() => seekBy(-10)} />
          <CtrlIcon name={paused ? 'play' : 'pause'} title={paused ? '播放 (空格)' : '暂停 (空格)'} onClick={togglePlay} />
          <CtrlIcon name="fwd10" title="前进 10 秒" onClick={() => seekBy(10)} />
          <span className="time-label">
            {fmt(seekPreview !== null && dur > 0 ? (seekPreview / 1000) * dur : cur)}
            {' / '}
            <span className="dim">{fmt(dur)}</span>
          </span>

          <div className="spacer" />

          <button
            className={`ctrl-btn ${openMenu === 'speed' ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'speed' ? null : 'speed') }}
            title="倍速"
          >
            {rate}×
          </button>
          {openMenu === 'speed' && (
            <div className="menu-pop" onClick={(e) => e.stopPropagation()}>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                <button
                  key={r}
                  className={`menu-item ${r === rate ? 'active' : ''}`}
                  onClick={() => { setOpenMenu(null); setRate(r); engineRef.current?.setRate(r) }}
                >
                  {r}x
                </button>
              ))}
            </div>
          )}

          <div className="volume-box">
            <button
              className="ctrl-btn"
              onClick={() => {
                const next = muted || volume === 0 ? Number(localStorage.getItem('ewp/volume') ?? 1) || 1 : 0
                engineRef.current?.setVolume(next)
                setVolume(next)
                setMuted(next === 0)
              }}
            >
              <Icon d={muted || volume === 0 ? ICONS.mute : ICONS.volume} />
            </button>
          </div>

          <div className="menu-box">
            <button
              className={`ctrl-btn ${openMenu === 'more' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'more' ? null : 'more') }}
              title="更多"
            >
              ⋮
            </button>
            {openMenu === 'more' && (
              <div className="more-menu" onClick={(e) => e.stopPropagation()}>
                {subError && <div className="menu-error">字幕加载失败:{subError}</div>}
                <div className="mm-section">
                  <div className="mm-title">字幕</div>
                  <button className={`menu-item ${activeSub === null ? 'active' : ''}`} onClick={() => setActiveSub(null)}>关闭字幕</button>
                  {subs.map((t) => (
                    <button key={t.index} className={`menu-item ${activeSub === t.index ? 'active' : ''}`} onClick={() => setActiveSub(t.index)}>
                      {t.label}{t.isGraphic ? '(图形字幕,原生渲染)' : ''}
                    </button>
                  ))}
                  {subs.length === 0 && <div className="menu-hint">没有可用字幕轨道</div>}
                </div>
                <div className="mm-section">
                  <div className="mm-title">音轨</div>
                  {audioTracks.length === 0 && <div className="menu-hint">没有可切换的音轨</div>}
                  {audioTracks.map((a) => (
                    <button
                      key={a.id}
                      className={`menu-item ${a.id === selectedAudioId ? 'active' : ''}`}
                      onClick={async () => { await engineRef.current?.selectAudio(a.id); setSelectedAudioId(a.id) }}
                    >
                      {a.label}{a.isDefault ? '(默认)' : ''}
                    </button>
                  ))}
                </div>
                <div className="mm-section">
                  <div className="mm-title">倍速</div>
                  <div className="mm-speeds">
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                      <button key={r} className={`menu-item ${r === rate ? 'active' : ''}`} onClick={() => { setRate(r); engineRef.current?.setRate(r) }}>
                        {r}x
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mm-section">
                  <button className="menu-item" onClick={() => setOpenMenu('diag')}>
                    播放链路面板
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            className={`ctrl-btn ${trOpen ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setTrOpen(!trOpen) }}
            title="字幕文稿"
          >
            文稿
          </button>
          <CtrlIcon name="fullscreen" title={isFullscreen ? '退出全屏' : '全屏 (F)'} onClick={toggleFullscreen} />
        </div>
      </div>
    </div>
  )
}
