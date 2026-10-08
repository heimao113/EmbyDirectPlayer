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
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import AVPlayer, { Events } from '@libmedia/avplayer'
import { AVCodecID } from '@libmedia/avutil/enum'
import { useApp } from '../state'
import { loadPlaySession } from '../player/session'
import type { BaseItem, MediaSource, MediaStream } from '../api/types'
import { buildDeviceProfile, isAudioLocallyDecodable, pickPreferredAudioIndex } from '../player/deviceProfile'
import { fetchSubtitleText, toFixedFormatAss, setBilingualStripPref, getBilingualStripPref, stripJapaneseEvents } from '../player/subtitles'
import { JassubHost } from '../player/jassubHost'
import { loadFontManifest, toJassubFontConfig, registerFontFaces } from '../player/fonts'
import { mapUint8Array } from '@libmedia/cheap'

const WASM_BASE = new URL(import.meta.env.BASE_URL, location.href).href

/** 控制栏 SVG 图标(B 站风格线性,替代字符/emoji,跨平台渲染一致) */
const I = {
  play: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.5-6.86a1.05 1.05 0 0 0 0-1.76L9.56 4.26A1.04 1.04 0 0 0 8 5.14z" /></svg>
  ),
  pause: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
  ),
  back10: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.99 5V1l-5 5 5 5v-4c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 19.99 13c0-4.42-3.58-8-8-8zm-7 1.2L3.58 7.61A7.93 7.93 0 0 0 1.99 13c0 4.42 3.58 8 8 8v-2c-3.31 0-6-2.69-6-6 0-1.78.78-3.38 2.02-4.47z" />
      <text x="12" y="15.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor" stroke="none">10</text>
    </svg>
  ),
  fwd10: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <g transform="translate(24 0) scale(-1 1)">
        <path d="M11.99 5V1l-5 5 5 5v-4c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 19.99 13c0-4.42-3.58-8-8-8zm-7 1.2L3.58 7.61A7.93 7.93 0 0 0 1.99 13c0 4.42 3.58 8 8 8v-2c-3.31 0-6-2.69-6-6 0-1.78.78-3.38 2.02-4.47z" />
      </g>
      <text x="12" y="15.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor" stroke="none">10</text>
    </svg>
  ),
  vol: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg>
  ),
  volOff: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" /></svg>
  ),
  fs: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
  ),
}

/** 错误浮层:vanilla DOM 直挂 body,React 树崩溃也能显示;msg 前缀区分来源 */
function reportFatal(msg: string) {
  try {
    let box = document.getElementById('ewp-fatal')
    if (!box) {
      box = document.createElement('div')
      box.id = 'ewp-fatal'
      box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;background:rgba(40,10,16,0.94);color:#ffb4c4;border:1px solid rgba(255,107,157,0.4);border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.5;word-break:break-all;max-height:40vh;overflow:auto'
      const copy = document.createElement('button')
      copy.textContent = '复制错误'
      copy.style.cssText = 'margin-top:6px;padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.25);background:transparent;color:#fff;font-size:12px'
      copy.onclick = () => { navigator.clipboard?.writeText(box?.dataset.msg ?? msg).catch(() => {}) }
      box.appendChild(copy)
      document.body.appendChild(box)
    }
    box.dataset.msg = msg
    const text = document.createElement('div')
    text.textContent = msg
    box.insertBefore(text, box.firstChild)
    while (box.children.length > 7) box.removeChild(box.children[box.children.length - 2])
  } catch { /* ignore */ }
}

/** 官方示例同款:getWasm 按 codecId 返回自托管解码器 */
function getWasm(type: 'decoder' | 'resampler' | 'stretchpitcher', codecId?: number): string {
  const v = WASM_SIMD ? 'simd' : ''
  const suffix = v ? `-${v}` : ''
  const d = `${WASM_BASE}wasm/decode/`
  if (type === 'decoder' && codecId !== undefined) {
    const map: Record<number, string> = {
      [AVCodecID.AV_CODEC_ID_AAC]: `${d}aac${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_MP3]: `${d}mp3${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_FLAC]: `${d}flac${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_AC3]: `${d}ac3${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_EAC3]: `${d}eac3${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_DTS]: `${d}dca${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_H264]: `${d}h264${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_HEVC]: `${d}hevc${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_AV1]: `${d}av1${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_VP8]: `${d}vp8${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_VP9]: `${d}vp9${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_MPEG2VIDEO]: `${d}mpeg2video${suffix}.wasm`,
      [AVCodecID.AV_CODEC_ID_MPEG4]: `${d}mpeg4${suffix}.wasm`,
    }
    if (map[codecId]) return map[codecId]
  }
  if (type === 'resampler') return `${WASM_BASE}wasm/resample/resample${suffix}.wasm`
  if (type === 'stretchpitcher') return `${WASM_BASE}wasm/stretchpitch/stretchpitch${suffix}.wasm`
  return `${d}aac${suffix}.wasm`
}

/** WASM SIMD 能力检测(官方标准字节序列):不支持的内核(部分国产手机浏览器)退回普通版解码器 */
const WASM_SIMD = (() => {
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    )
  } catch {
    return false
  }
})()

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
  const [searchParams] = useSearchParams()
  const { api: sharedApi } = useApp()

  // 备用线路:详情页"备用线路"按钮把反代地址写进播放会话,这里克隆 api
  // 让播放链路所有请求(PlaybackInfo/媒体流/字幕/进度)都走该反代
  const viaMirror = useMemo(() => {
    const sid = searchParams.get('session')
    const sess = sid ? loadPlaySession(sid) : null
    return sess?.srv ?? ''
  }, [searchParams])
  const api = useMemo(
    () => (viaMirror ? sharedApi.withServer(viaMirror) : sharedApi),
    [sharedApi, viaMirror],
  )

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
  const extSubsPRef = useRef<Promise<Array<{ source: File; lang?: string; title?: string; embyIndex: number }>> | null>(null)
  const extSubsLoadedRef = useRef<Array<{ source: File; lang?: string; title?: string; embyIndex: number }>>([])
  const readyAtRef = useRef(0)
  // 触屏设备:视频区单击 = 呼出控制栏(桌面单击 = 暂停)
  const coarsePointerRef = useRef(typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches)
  const lastTapRef = useRef(0)
  const lastUiTickRef = useRef(0)
  const tapStartedVisibleRef = useRef(false)
  const vDeadCountRef = useRef(0)
  // 音频存活以内核事件为准(FIRST_AUDIO_RENDERED);帧率统计在 wasm 模式恒为 0,不可作依据
  const audioAliveRef = useRef(false)
  // 播放后若 AudioContext 被自动播放策略挂起 → 主动暂停,等用户手势再续(否则音频时钟会把播放拽回 0)
  const smartPlay = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    void p.play().catch(() => {})
    window.setTimeout(() => {
      try {
        const AP = AVPlayer as unknown as { isAudioContextSuspended?: () => boolean }
        if (AP.isAudioContextSuspended?.()) {
          p.pause()
          setAudioDead(true)
        }
      } catch { /* ignore */ }
    }, 800)
  }, [])
  // 设备自适应:默认 wasm(规格 §6),检测到 wasm 撑不住(解封装失败/帧率过低/反复无渲染)的设备升级 MSE
  const useMseRef = useRef(false)
  const demuxErrCountRef = useRef(0)
  const lowFpsTicksRef = useRef(0)
  const vDeadReloadCountRef = useRef(0)
  // 通道升级时记录实时位置,重新 resolve 后从这里续播
  const escalateSeekRef = useRef<number | null>(null)
  // escalateToMSE 在后方定义,经由 ref 转发给更早绑定的事件处理器
  const escalateRef = useRef<(reason: string) => void>(() => {})
  // 本次点击用于恢复声音(刷新后 AudioContext 被挂起)时,抑制其播放/暂停切换
  const audioRecoveringRef = useRef(false)
  // 方向锁定失败(部分安卓内核在全屏切换中会 cancel lock)→ CSS 旋转 90° 模拟横屏(B 站同款兜底)
  const [forceLandscape, setForceLandscape] = useState(false)
  const orientRetryRef = useRef<number[]>([])
  const [gotFirstFrame, setGotFirstFrame] = useState(false)
  // 刷新后自动播放策略会挂起 AudioContext(视频 canvas 照走、无声):需要用户手势恢复
  const [audioDead, setAudioDead] = useState(false)
  const [seekFlash, setSeekFlash] = useState<{ side: 'l' | 'r' } | null>(null)
  const flashTimerRef = useRef<number | undefined>(undefined)
  const flashSeek = useCallback((side: 'l' | 'r') => {
    setSeekFlash({ side })
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setSeekFlash(null), 620)
  }, [])
  const jassubRef = useRef<JassubHost | null>(null)
  const embeddedFontsRef = useRef<Uint8Array[] | null>(null)
  const lastAssRef = useRef<{ content: string; vw: number; vh: number } | null>(null)

  const [item, setItem] = useState<BaseItem | null>(null)
  const [src, setSrc] = useState<SrcInfo | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errText, setErrText] = useState('')
  const [stage, setStage] = useState(() => (viaMirror ? '正在建立播放链路(备用线路)…' : '正在建立播放链路…'))
  const [badge, setBadge] = useState('')
  // 控制栏状态
  const [paused, setPaused] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('ewp/volume') ?? 1) || 1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [subOn, setSubOn] = useState(true)
  // 字幕轨选择(UHD 式):全部文本轨列出由用户挑选
  const [subMenuTracks, setSubMenuTracks] = useState<Array<{ embyIndex: number; label: string }>>([])
  const [selectedSubEmby, setSelectedSubEmby] = useState<number | null>(null)
  const preferredSubEmbyRef = useRef(0)
  // 通道升级计数:变更触发 init effect 完整重新 resolve
  const [resolveNonce, setResolveNonce] = useState(0)
  const extSubStreamIdOfRef = useRef<Map<number, number>>(new Map())
  const [showControls, setShowControls] = useState(true)
  const [openMenu, setOpenMenu] = useState<'audio' | 'speed' | 'sub' | null>(null)
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

  // ---------- MSE 管线 video 元素铺满(内联样式,优先级最高) ----------
  useEffect(() => {
    if (status !== 'ready') return
    let n = 0
    const t = setInterval(() => {
      n += 1
      const v = surfaceRef.current?.querySelector('video')
      if (v) {
        const need = v.style.position !== 'absolute' || v.style.width !== '100%' || v.style.objectFit !== 'contain'
        if (need) {
          v.style.position = 'absolute'
          v.style.inset = '0'
          v.style.width = '100%'
          v.style.height = '100%'
          v.style.objectFit = 'contain'
          v.style.background = '#000'
        }
      }
      if (n >= 15) window.clearInterval(t)
    }, 1000)
    return () => window.clearInterval(t)
  }, [status])

  // ---------- MSE video 元素铺满监护(移回渲染面 + 内联样式) ----------
  useEffect(() => {
    if (status !== 'ready') return
    let n = 0
    const t = setInterval(() => {
      const surface = surfaceRef.current
      const v = document.querySelector('.ui-player-page video') as HTMLVideoElement | null
      if (!v || !surface) return
      if (v.parentElement !== surface) surface.appendChild(v)
      if (v.style.position !== 'absolute' || v.style.width !== '100%' || v.style.objectFit !== 'contain') {
        v.style.position = 'absolute'
        v.style.inset = '0'
        v.style.width = '100%'
        v.style.height = '100%'
        v.style.objectFit = 'contain'
        v.style.background = '#000'
      }
      n += 1
      if (n >= 15) window.clearInterval(t)
    }, 1000)
    return () => window.clearInterval(t)
  }, [status])

  // ---------- 字幕准备:Emby 文本字幕 → 官方 externalSubtitles ----------
  const prepareExternalSubs = useCallback(async (): Promise<Array<{ source: File; lang?: string; title?: string; embyIndex: number }>> => {
    const ms = msRef.current
    if (!ms) return []
    // 取回片源的全部文本字幕轨(每轨独立提取、独立容错):
    // libmedia 的 demuxer 对部分 MKV 解不出字幕流(如罪恶王冠/旋风管家),
    // 必须通过 Emby 提取接口获取字幕内容,经 loadExternalSubtitle 装载
    const text = (ms.MediaStreams ?? []).filter(
      (x) =>
        x.Type === 'Subtitle' &&
        !['pgs', 'pgssub', 'dvdsub', 'sup', 'dvbsub'].includes((x.Codec ?? '').toLowerCase()),
    )
    if (text.length === 0) return []
    const strip = getBilingualStripPref()
    const results = await Promise.all(
      text.map(async (pick): Promise<{ source: File; lang: string; title: string; embyIndex: number } | null> => {
        try {
          const raw = await fetchSubtitleText(
            api,
            { index: pick.Index, label: pick.DisplayTitle ?? '', codec: pick.Codec ?? '', isText: true, isGraphic: false, deliveryUrl: pick.DeliveryUrl },
            itemId,
            ms.Id,
          )
          // 固定格式:统一思源黑体/底部居中,双语按行堆叠;双语剥离按持久化偏好
          const base = strip ? stripJapaneseEvents(raw) : raw
          const content = toFixedFormatAss(base, 1920, 1080)
          const file = new File([content], `subtitle-${pick.Index}.ass`, { type: 'text/plain' })
          console.info(`[subtitle] 提取(固定格式):轨 ${pick.Index} ${pick.Codec} ${Math.round(content.length / 1024)}KB`)
          return {
            source: file,
            lang: pick.Language ?? pick.Codec ?? '',
            title: pick.DisplayTitle ?? pick.Title ?? `字幕轨 ${pick.Index}`,
            embyIndex: pick.Index,
          }
        } catch (e) {
          console.warn('[subtitle] 轨道提取失败,跳过', pick.Index, e)
          return null
        }
      }),
    )
    const out = results.filter((x): x is NonNullable<typeof x> => x !== null)
    // 菜单清单 + 初始优先轨(默认标记 > 中文 > 第一条)
    setSubMenuTracks(out.map((o) => ({ embyIndex: o.embyIndex, label: o.title })))
    const best =
      text.find((t) => t.IsDefault) ??
      text.find((t) => (t.Language ?? '').toLowerCase().startsWith('zh')) ??
      text[0]
    preferredSubEmbyRef.current = best.Index
    out.sort((a, b) => (a.embyIndex === best.Index ? -1 : b.embyIndex === best.Index ? 1 : 0))
    return out
  }, [api, itemId])

  // 装载全部外挂字幕并捕获各自的内核流 id(逐个 diff),随后选中优先轨
  const attachSubtitles = useCallback(async () => {
    const player = playerRef.current
    const subs = extSubsLoadedRef.current
    if (!player || subs.length === 0) return
    const snapSubIds = () =>
      new Set(
        (player.getStreams?.() ?? [])
          .filter((x) => (x as { mediaType?: string }).mediaType === 'subtitle')
          .map((x) => (x as { id: number }).id),
      )
    const idOf = new Map<number, number>()
    let known = snapSubIds()
    for (const s of subs) {
      try {
        await player.loadExternalSubtitle(s)
      } catch (err) {
        console.warn('[subtitle] 装载失败', err)
        continue
      }
      const nowIds = snapSubIds()
      for (const id of nowIds) {
        if (!known.has(id) && ![...idOf.values()].includes(id)) {
          idOf.set((s as { embyIndex: number }).embyIndex, id)
          break
        }
      }
      known = nowIds
    }
    extSubStreamIdOfRef.current = idOf
    const pid = idOf.get(preferredSubEmbyRef.current)
    if (pid) {
      setSelectedSubEmby(preferredSubEmbyRef.current)
      await player.selectSubtitle(pid).catch(() => {})
    }
    console.info(`[subtitle] 外挂字幕已装载:${subs.length} 条,可选 ${idOf.size} 条`)
  }, [])

  // ---------- 创建官方 AVPlayer(一次) ----------
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
      // 官方参数调优(参照 libmedia master 源码默认值):
      // preLoadTime 默认 4s(内核预解码满 4s 帧才出画)——续播跳转/弱设备都要白等解码,
      // 统一降到 2s:出画时间减半,起播缓冲 2s 对点播足够
      preLoadTime: 2,
      // audioWorkletBufferLength 默认桌面 10/移动 20——官方注释:通信延迟大会音频卡顿,可调大。移动端提到 40
      audioWorkletBufferLength: coarsePointerRef.current ? 40 : 10,
      // 规格 §6.1 强制 wasm 软解:不用 MSE 通道。
      // 弱内核(部分安卓浏览器)的 MSE worker 会被系统掐死,残留 postMessage 调用直接崩;
      // wasm + canvas + WebAudio 全程自渲染,状态自洽,移动端确定性最好
      checkUseMSE: () => useMseRef.current,
    } as never)
    playerRef.current = player
    ;(window as unknown as Record<string, unknown>).__litePlayer = player
    ;(window as unknown as Record<string, unknown>).__AVP = AVPlayer
  }, [])


  // ---------- 用户手势恢复音频上下文(刷新后自动播放策略挂起 AudioContext 导致无声) ----------
  const recoverAudioCtx = useCallback(() => {
    try {
      const AP = AVPlayer as unknown as { isAudioContextSuspended?: () => boolean; startAudioContext?: () => Promise<void> }
      const p = playerRef.current as unknown as { resume?: () => Promise<void> } | null
      const kick = async () => {
        if (AP.isAudioContextSuspended?.()) await AP.startAudioContext?.()
        // 音频管线自身的恢复接口(刷新后管线可能停在暂停态)
        await p?.resume?.()
        await playerRef.current?.play().catch(() => {})
      }
      void kick()
    } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    if (status !== 'ready') return
    const onGesture = () => {
      if (!audioAliveRef.current) {
        audioRecoveringRef.current = true
        window.setTimeout(() => { audioRecoveringRef.current = false }, 900)
        recoverAudioCtx()
        // 手势在场,恢复上下文后自动续播(从暂停的续播位继续)
        window.setTimeout(() => smartPlay(), 250)
      }
    }
    document.addEventListener('pointerdown', onGesture)
    document.addEventListener('keydown', onGesture)
    document.addEventListener('touchstart', onGesture, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', onGesture)
      document.removeEventListener('keydown', onGesture)
      document.removeEventListener('touchstart', onGesture)
    }
  }, [status, recoverAudioCtx])

  // ---------- 全局崩溃捕获:手机浏览器上渲染/解码异常时把原因直接显示在页面上 ----------
  useEffect(() => {
    const show = (msg: string) => reportFatal(msg)
    // 这些是播放内核的良性噪音(初始化竞态/自动播放策略中断),不影响播放,不展示
    const BENIGN = [
      'player status is not loaded',
      'The play() request was interrupted',
      'interacted with the',
      'AbortError',
      'exitFullscreen',
      ' lock',
    ]
    const benign = (m: string) => BENIGN.some((p) => m.includes(p))
    const onErr = (e: ErrorEvent) => {
      if (e.message && !benign(e.message)) show('JS错误: ' + e.message)
    }
    const onRej = (e: PromiseRejectionEvent) => {
      const m = String(e.reason?.message ?? e.reason)
      if (!benign(m)) show('Promise拒绝: ' + m)
    }
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
      document.getElementById('ewp-fatal')?.remove()
    }
  }, [])

  // ---------- 生命周期事件绑定(一次) ----------
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    player.on(Events.ERROR, (...args: unknown[]) => {
      // 内核 ERROR 不都是致命的(如 IO 重试、加载竞态):只记录到浮层,不打断播放
      const e = args[1] ?? args[0]
      const msg = String((e as { message?: string })?.message ?? e).slice(0, 300)
      console.error('[player] libmedia ERROR', args)
      if (msg.includes('demux error')) {
        demuxErrCountRef.current += 1
        if (demuxErrCountRef.current >= 3) escalateRef.current('WASM 解封装连续失败')
      }
      reportFatal('内核: ' + msg)
    })
    // 音频/首帧权威信号
    player.on(Events.FIRST_AUDIO_RENDERED, () => { audioAliveRef.current = true; setAudioDead(false) })
    player.on(Events.AUDIO_CONTEXT_RUNNING, () => { audioAliveRef.current = true; setAudioDead(false) })
    player.on(Events.FIRST_VIDEO_RENDERED, () => setGotFirstFrame(true))
    // 续播自愈:LOADED 时刻管线可能尚未可 seek(静默失败→从头播),2.5 秒后校验实际位置,未到位重发一次
    const verifySeek = (target: number) => {
      window.setTimeout(() => {
        const p = playerRef.current
        if (!p || reloadingRef.current) return
        // 注意:暂停中也要校验——刷新后可能因音频上下文挂起被主动暂停,
        // 此时若初始 seek 静默失败,必须把位置纠正回来,否则用户恢复声音后从头播/字幕错位
        if (seekLockRef.current || Date.now() - lastSeekDoneRef.current < 2500) return
        const nowSec = Number(p.currentTime ?? 0) / 1000
        if (Math.abs(nowSec - target) > 3) {
          console.warn(`[resume] 续播未生效(${nowSec.toFixed(1)}s ≠ ${target.toFixed(1)}s),重新 seek`)
          lastSeekDoneRef.current = Date.now()
          void p.seek(BigInt(Math.round(target * 1000))).catch(() => {})
        }
      }, 2500)
    }
    player.on(Events.LOADED, () => {
      startedRef.current = true
      readyAtRef.current = Date.now()
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
        verifySeek(seek)
      }
      smartPlay()
    })
    player.on(Events.PAUSED, () => { pausedRef.current = true; setPaused(true) })
    player.on(Events.PLAYED, () => { pausedRef.current = false; setPaused(false) })
    player.on(Events.TIME, () => {
      if (pausedRef.current) pausedRef.current = false
      try {
        const nowMs = Date.now()
        const nowSec = Number(player.currentTime ?? 0) / 1000
        const lock = seekLockRef.current
        if (lock) {
          if (Math.abs(nowSec - lock.target) <= 2.5 || nowMs > lock.until) seekLockRef.current = null
          else {
            // seek 追上之前,进度条与时间显示保持在目标位置(不回跳)
            setCur(lock.target)
            return
          }
        }
        // 首帧检测:MSE 由浏览器解码(立即算出帧);wasm 软解等渲染帧率 >0 才算出画
        let st: { videoRenderFramerate?: unknown } | undefined
        try { st = player.getStats?.() } catch { /* ignore */ }
        if (!gotFirstFrame) {
          try {
            const isMSE = !!surfaceRef.current?.querySelector('video')
            if (isMSE || Number(st?.videoRenderFramerate ?? 0) > 0) setGotFirstFrame(true)
          } catch { /* ignore */ }
        }
        // 软解卡顿升级采样:wasm 模式已出帧但帧率持续过低(~5 秒)→ 升级 MSE
        if (!useMseRef.current && gotFirstFrame && !pausedRef.current && dur > 0) {
          const fps = Number(st?.videoRenderFramerate ?? 0)
          lowFpsTicksRef.current = fps > 0 && fps < 12 ? lowFpsTicksRef.current + 1 : 0
          if (lowFpsTicksRef.current >= 12) {
            lowFpsTicksRef.current = 0
            escalateRef.current('软解帧率过低(' + fps.toFixed(1) + 'fps)')
          }
        }
        // seek 后视频防活:6 秒内 seek 过且渲染帧率持续为 0(≥1.6s)→ 软重载自愈
        // (部分内核 wasm demuxer seek 后报 demux error -2 且不再恢复)
        if (!pausedRef.current && nowMs - lastSeekDoneRef.current < 6000) {
          let vDead = false
          try {
            const st = player.getStats?.()
            vDead = Number(st?.videoRenderFramerate ?? 0) === 0
          } catch { /* ignore */ }
          vDeadCountRef.current = vDead ? vDeadCountRef.current + 1 : 0
          if (vDeadCountRef.current >= 4) {
            vDeadCountRef.current = 0
            console.warn('[player] seek 后视频无渲染,软重载恢复')
            vDeadReloadCountRef.current += 1
            if (vDeadReloadCountRef.current >= 2) escalateRef.current('WASM 视频反复无渲染')
            void hardReload(Number(player.currentTime ?? 0) / 1000)
            return
          }
        } else {
          vDeadCountRef.current = 0
        }
        // 节流:时间事件 ~4Hz,整树重渲染在低端手机上会引发控制栏闪烁,限到 ~2.5Hz
        if (nowMs - lastUiTickRef.current < 400) return
        lastUiTickRef.current = nowMs
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
  }, [api, itemId, item, navigate, gotFirstFrame])

  // ---------- 初始化:媒体信息 + 播放决策 ----------
  useEffect(() => {
    let cancelled = false
    setBilingualStripPref(getBilingualStripPref())
    ;(async () => {
      try {
        // 手机浏览器(尤其部分国产浏览器)WebGL 被禁时视频无法渲染,提前给出明确提示
        const glOk = (() => {
          try {
            const t = document.createElement('canvas')
            return !!(t.getContext('webgl2') || t.getContext('webgl'))
          } catch { return false }
        })()
        if (!glOk) {
          setStatus('error')
          setErrText('当前浏览器不支持 WebGL 视频渲染(部分安卓自带/加速浏览器常见)。请改用 Chrome,或在浏览器设置里关闭「云端加速/极速模式」,或切换「电脑版网页」后重试。')
          return
        }
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
          pendingSeekRef.current = pos > 10 ? pos - 0.75 : 0
          // 通道升级重建会话:以升级瞬间的实时位置为准(比服务器上报的更接近当前)
          if (escalateSeekRef.current != null) {
            pendingSeekRef.current = Math.max(0, escalateSeekRef.current - 0.5)
            escalateSeekRef.current = null
          }
          setBadge('直连')
          setSrc({
            // 不带媒体扩展名:避开手机浏览器"媒体嗅探"弹出下载面板(嗅探器按 .mp4/.mkv 后缀抓)
            url: api.mediaUrl(`/emby/Videos/${itemId}/stream`, {
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
  }, [api, itemId, navigate, profile, resolveNonce])

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
        extSubsLoadedRef.current = subs
        await attachSubtitles()
        if (cancelled) return
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setErrText(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [src, prepareExternalSubs, attachSubtitles])


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

  // DOM 字体注册:libmedia 字幕是 DOM 渲染,靠 CSS 字体匹配
  useEffect(() => {
    if (status !== 'ready') return
    void registerFontFaces()
  }, [status])

  // ---------- 字幕装载:文本轨 → 固定格式 → JASSUB;PGS → libmedia 原生 ----------
  useEffect(() => {
    const t = setTimeout(async () => {
      const player = playerRef.current
      const surface = surfaceRef.current
      const ms = msRef.current
      if (!player || !surface || !ms) return
      try {
        const all = (ms.MediaStreams ?? []).filter((x) => x.Type === 'Subtitle')
        const textSubs = all.filter((x) => !['pgs', 'pgssub', 'dvdsub', 'sup', 'dvbsub'].includes((x.Codec ?? '').toLowerCase()))
        // 无文本轨:尝试内嵌 PGS(中文优先)交给 libmedia 原生渲染
        if (textSubs.length === 0) {
          const pgs = all.find((x) => (x.Language ?? '').toLowerCase().startsWith('zh')) ?? all[0]
          if (pgs) {
            const streams = (player.getStreams?.() ?? []) as unknown as Array<{ id: number; index?: number }>
            const target = streams.find((s) => Number(s.index) === pgs.Index)
            if (target) {
              await player.selectSubtitle(target.id).catch(() => {})
              player.setSubtitleEnable(true)
              console.info(`[subtitle] 位图字幕轨已选:轨 ${pgs.Index}`)
            }
          }
          return
        }
        // 选最佳文本轨:默认 > 中文 > 第一条
        const pick =
          textSubs.find((x) => x.IsDefault) ??
          textSubs.find((x) => (x.Language ?? '').toLowerCase().startsWith('zh')) ??
          textSubs[0]
        const raw = await fetchSubtitleText(
          api,
          { index: pick.Index, label: pick.DisplayTitle ?? '', codec: pick.Codec ?? '', isText: true, isGraphic: false, deliveryUrl: pick.DeliveryUrl },
          itemId,
          ms.Id,
        )
        const v0 = (ms.MediaStreams ?? []).find((x) => x.Type === 'Video')
        // 固定格式:统一思源黑体/底部居中,双语按行堆叠(偏好:剥离日文行)
        const content = toFixedFormatAss(raw, 1920, 1080, { stripBilingual: getBilingualStripPref() })
        lastAssRef.current = { content, vw: v0?.Width ?? 1920, vh: v0?.Height ?? 1080 }
        // 字体:JASSUB 内嵌 fonts(库内嵌字体字节)+ availableFonts(TTF 清单)
        if (!embeddedFontsRef.current) {
          try {
            const fonts: Uint8Array[] = []
            let total = 0
            const proxies = ((player.getStreams?.() ?? []) as unknown as Array<{
              id: number
              codecparProxy?: { codecType?: unknown; extradata?: unknown; extradataSize?: unknown }
              metadata?: { filename?: string }
            }>)
            for (const g of proxies) {
              const cp = g.codecparProxy
              if (!cp || Number(cp.codecType) !== 4) continue // ATTACHMENT
              const size = Number(cp.extradataSize ?? 0)
              if (size < 128 || total + size > 96 * 1024 * 1024) continue
              const view = mapUint8Array(cp.extradata as never, size)
              fonts.push(new Uint8Array(view))
              total += size
            }
            embeddedFontsRef.current = fonts
            console.info(`[subtitle] MKV 内嵌字体:${fonts.length} 个 / ${Math.round(total / 1024)}KB`)
          } catch { /* ignore */ }
        }
        const cfg = toJassubFontConfig(await loadFontManifest())
        jassubRef.current?.detach()
        const host = new JassubHost()
        jassubRef.current = host
        await host.attach({
          surface,
          assContent: content,
          availableFonts: cfg.availableFonts,
          defaultFont: cfg.fallback || 'sans-serif',
          fonts: embeddedFontsRef.current ?? [],
          getSec: () => Number(player.currentTime ?? 0) / 1000,
        })
        // 关闭 libmedia 内置渲染,避免与 JASSUB 双重字幕
        player.setSubtitleEnable(false)
        setSubOn(true)
        console.info(`[subtitle] JASSUB 已挂载:轨 ${pick.Index} ${Math.round(content.length / 1024)}KB`)
      } catch (e) {
        console.warn('[subtitle] 装载失败(可尝试切换字幕轨)', e)
      }
    }, 800)
    return () => clearTimeout(t)
  }, [status, itemId, api, subOn])

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
  // 重载恢复:load 会清掉外挂字幕,必须重新挂载,否则字幕退回内嵌渲染(样式/对位与主链路不一致)
  const reloadingRef = useRef(false)
  const hardReload = useCallback(async (atSec: number) => {
    const player = playerRef.current
    if (!player || !srcRef.current) return
    if (reloadingRef.current) return
    reloadingRef.current = true
    setGotFirstFrame(false)
    audioAliveRef.current = false
    setStage('正在恢复播放…')
    try {
      await player.load(srcRef.current.url, { ext: srcRef.current.ext } as never)
      await attachSubtitles()
      if (atSec > 0) {
        void player.seek(BigInt(Math.round(atSec * 1000))).catch(() => {})
        // 软重载后的 seek 同样校验一次(MSE 升级后的重协商窗口可能吞掉首次 seek)
        window.setTimeout(() => {
          const p = playerRef.current
          if (!p || reloadingRef.current) return
          const nowSec = Number(p.currentTime ?? 0) / 1000
          if (Math.abs(nowSec - atSec) > 3) {
            console.warn(`[reload] 恢复位置未生效(${nowSec.toFixed(1)}s ≠ ${atSec.toFixed(1)}s),重新 seek`)
            void p.seek(BigInt(Math.round(atSec * 1000))).catch(() => {})
          }
        }, 2500)
      }
      smartPlay()
    } catch { /* 失败则等下个周期再试 */ } finally {
      reloadingRef.current = false
    }
  }, [attachSubtitles, smartPlay])


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
          void hardReload(sec)
        }
      } else {
        stall.lastSec = sec
        stall.lastTs = now
      }
      // 音频异常兜底:上下文在跑、非暂停,但 5 分钟迟迟无 FIRST_AUDIO_RENDERED(管线真死)→ 软重载
      const hasAudio = (msRef.current?.MediaStreams?.some((x) => x.Type === 'Audio')) ?? false
      if (hasAudio && !audioAliveRef.current && !pausedRef.current && now - readyAtRef.current > 300_000 && now - audio.lastAt > 60_000) {
        audio.lastAt = now
        console.warn('[player] 5 分钟无音频渲染,软重载恢复')
        void hardReload(sec)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [status, src, hardReload])


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

  const seekCoalesceRef = useRef<{ at: number; timer?: number }>({ at: 0 })
  const lastSeekDoneRef = useRef(0)
  const commitSeek = useCallback((targetSec: number) => {
    const target = Math.max(0, Math.min(targetSec, dur || targetSec))
    seekLockRef.current = { target, until: Date.now() + 6000 }
    setCur(target)
    const doSeek = () => {
      const player = playerRef.current
      if (!player) return
      // 软重载进行中:worker 正在重建,seek 转为待执行
      if (reloadingRef.current) {
        pendingSeekRef.current = target
        return
      }
      // 时长未知(demux 异常/未就绪)时 seek 会触发内核 BigInt 除零,转待执行
      if (!dur) {
        pendingSeekRef.current = target
        return
      }
      try {
        // demux 流未就绪(刚加载/加载中)时 seek 会崩 → 转为 LOADED 后应用的待执行 seek
        const ready = ((player.getStreams?.() ?? []) as unknown as Array<unknown>).length > 0
        if (!ready) {
          pendingSeekRef.current = target
          return
        }
        lastSeekDoneRef.current = Date.now()
        void player.seek(BigInt(Math.round(target * 1000))).catch(() => {})
      } catch {
        pendingSeekRef.current = target
      }
    }
    // 连击合并:350ms 内的连续 seek(双击快进/键盘连按/拖动)只执行最后一次,
    // 高频 seek 会把 wasm 解码器打进出错状态(音轨掉/字幕乱)
    const now = Date.now()
    if (now - seekCoalesceRef.current.at < 350) {
      seekCoalesceRef.current.at = now
      if (seekCoalesceRef.current.timer) window.clearTimeout(seekCoalesceRef.current.timer)
      seekCoalesceRef.current.timer = window.setTimeout(() => {
        seekCoalesceRef.current.at = Date.now()
        doSeek()
      }, 300)
      return
    }
    seekCoalesceRef.current.at = now
    doSeek()
  }, [dur])
  const seekBy = useCallback((delta: number) => {
    commitSeek(Math.max(0, Math.min(dur || 1e9, cur + delta)))
  }, [commitSeek, cur, dur])

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



  // 尝试锁定横屏:部分内核在全屏未完全落定时会 cancel lock,失败按 250/500/750/1000ms 重试,
  // 全部失败则降级为 CSS 旋转 90° 模拟横屏(B 站移动端同款兜底)
  const tryLockLandscape = useCallback((attempt: number) => {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    if (!so?.lock) {
      setForceLandscape(true)
      return
    }
    so.lock('landscape')
      .then(() => { setForceLandscape(false); kickResize() })
      .catch(() => {
        if (attempt >= 4) {
          setForceLandscape(true)
          return
        }
        const t = window.setTimeout(() => tryLockLandscape(attempt + 1), 250 * (attempt + 1))
        orientRetryRef.current.push(t)
      })
  }, [])

  const clearOrientRetry = useCallback(() => {
    orientRetryRef.current.forEach((t) => window.clearTimeout(t))
    orientRetryRef.current = []
  }, [])

  // CSS 旋转/全屏切换不会自动触发 resize,内核(libmedia)会按旧尺寸摆视频面导致画面被拉扁;
  // 在数百毫秒内多次补发 resize 强制重算
  const kickResize = useCallback(() => {
    ;[60, 300, 800, 1500, 2500].forEach((d) => {
      window.setTimeout(() => {
        try { window.dispatchEvent(new Event('resize')) } catch { /* ignore */ }
        try {
          // 直接调用内核 resize:全屏/旋转后按容器实时尺寸重算视频面(修复画面条)
          const rect = surfaceRef.current?.getBoundingClientRect()
          if (rect && rect.width > 0 && rect.height > 0) {
            playerRef.current?.resize(Math.round(rect.width), Math.round(rect.height))
          }
        } catch { /* ignore */ }
      }, d)
    })
  }, [])

  // 设备自适应升级:MSE 兼容通道。关键:不复用旧 URL/旧 PlaySession(可能已失效),
  // 而是完整重新 resolve(全新会话)+ 从实时位置续播
  const escalateToMSE = useCallback((reason: string) => {
    if (useMseRef.current) return
    useMseRef.current = true
    demuxErrCountRef.current = 0
    vDeadReloadCountRef.current = 0
    const sec = Number(playerRef.current?.currentTime ?? 0) / 1000
    escalateSeekRef.current = sec > 5 ? sec : null
    reportFatal('已切换兼容解码通道(MSE)并重新建立会话: ' + reason)
    setResolveNonce((n) => n + 1)
  }, [])
  escalateRef.current = escalateToMSE

  const toggleFullscreen = useCallback(() => {
    const el = shellRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null
    try {
      if (document.fullscreenElement) {
        clearOrientRetry()
        setForceLandscape(false)
        kickResize()
        try { (screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.() } catch { /* ignore */ }
        void document.exitFullscreen().catch(() => {})
        return
      }
      const req = el?.requestFullscreen?.bind(el) ?? el?.webkitRequestFullscreen?.bind(el)
      if (!req) {
        reportFatal('当前浏览器不支持网页全屏 API,请改用 Chrome')
        setForceLandscape(true)
        return
      }
      Promise.resolve(req()).then(() => {
        // 手机上进入全屏自动横屏;锁定失败自动降级 CSS 模拟横屏
        // 注意:进全屏不做软重载——会和内核自身全屏 resize 处理撞车(worker 已销毁仍被 postMessage)
        tryLockLandscape(0)
        kickResize()
      }).catch((e: unknown) => {
        reportFatal('进入全屏失败: ' + String((e as Error)?.message ?? e))
        setForceLandscape(true)
      })
    } catch (e) {
      reportFatal('全屏异常: ' + String((e as Error)?.message ?? e))
    }
  }, [tryLockLandscape, clearOrientRetry, kickResize])

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

  // 自动隐藏控制栏:桌面 3 秒 / 触屏 8 秒无操作隐藏,暂停时常显
  // 注意:触屏下 touchstart 不能无条件唤醒,否则与 surface 单击"取反"叠加成"闪现即消失"
  const armHide = useCallback(() => {
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => {
      if (!pausedRef.current) setShowControls(false)
    }, coarse ? 8000 : 3000)
  }, [])
  const pickSubTrack = useCallback((embyIndex: number) => {
    const player = playerRef.current
    if (!player) return
    const sid = extSubStreamIdOfRef.current.get(embyIndex)
    setSelectedSubEmby(embyIndex)
    setSubOn(true)
    preferredSubEmbyRef.current = embyIndex
    player.setSubtitleEnable(true)
    if (sid) void player.selectSubtitle(sid).catch(() => {})
    setOpenMenu(null)
    armHide()
  }, [armHide])

  const closeSub = useCallback(() => {
    playerRef.current?.setSubtitleEnable(false)
    setSubOn(false)
    setOpenMenu(null)
    armHide()
  }, [armHide])
  useEffect(() => {
    const wake = () => {
      setShowControls(true)
      armHide()
    }
    wake()
    const el = shellRef.current
    const coarseDev = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
    const onMove = () => wake()
    const onTouch = (e: TouchEvent) => {
      // 触屏:点到控制栏/顶栏才保持显示;点视频区由 surface onClick 接管显隐
      const t = e.target as HTMLElement | null
      if (t?.closest('.ui-controls, .ui-top')) wake()
    }
    if (!coarseDev) el?.addEventListener('mousemove', onMove)
    el?.addEventListener('touchstart', onTouch, { passive: true })
    return () => {
      if (!coarseDev) el?.removeEventListener('mousemove', onMove)
      el?.removeEventListener('touchstart', onTouch)
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
    }
  }, [status, armHide])

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
      // 片源码率(元数据声明值):缓冲满时 IO 停止、吞吐增量趋近 0,不能当码率显示
      const srcMbps = ((vEm?.BitRate ?? 0) + (aEm?.BitRate ?? 0)) / 1_000_000
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
        mbps: srcMbps > 0 ? srcMbps.toFixed(1) : mbpsTotal.toFixed(1),
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

  // ---------- 全屏态清理:用户从系统手势退出全屏时同步撤销 CSS 横屏 ----------
  useEffect(() => {
    if (!forceLandscape) return
    const onFsChange = () => {
      if (!document.fullscreenElement) {
        clearOrientRetry()
        setForceLandscape(false)
      }
    }
    const onResize = () => {
      // 用户物理旋转到横屏后,CSS 旋转就多余了
      if (window.innerWidth > window.innerHeight) setForceLandscape(false)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    window.addEventListener('resize', onResize)
    const t = window.setTimeout(kickResize, 120)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('fullscreenchange', onFsChange)
      window.removeEventListener('resize', onResize)
    }
  }, [forceLandscape, clearOrientRetry, kickResize])

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
      className={`ui-player-page ${forceLandscape ? 'ui-force-landscape' : ''} ${!showControls && status === 'ready' && !paused ? 'ui-hide-cursor' : ''}`}
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
        onTouchStart={() => {
          // 记录按下瞬间控制栏的可见性:touchstart 先于浏览器补发的合成 mousemove/click,
          // 以此为准就不会被"先唤醒再取反"搞成闪现
          tapStartedVisibleRef.current = showControls
        }}
        onClick={(e) => {
          // 本次点击用于恢复声音(刷新后无声),不切换播放/暂停
          if (audioRecoveringRef.current) {
            audioRecoveringRef.current = false
            armHide()
            return
          }
          // 触屏:单击呼出/隐藏控制栏;双击分区 —— 左 40% 快退 10s,右 40% 快进 10s,中间播放/暂停(B 站交互)
          if (coarsePointerRef.current) {
            const now = Date.now()
            if (now - lastTapRef.current < 320) {
              lastTapRef.current = 0
              setShowControls(true)
              armHide()
              const rect = surfaceRef.current?.getBoundingClientRect()
              const x = rect ? (e.clientX - rect.left) / rect.width : 0.5
              if (x < 0.4) {
                commitSeek(Math.max(0, cur - 10))
                flashSeek('l')
              } else if (x > 0.6) {
                commitSeek(Math.min(dur || 1e9, cur + 10))
                flashSeek('r')
              } else {
                togglePlay()
              }
            } else {
              lastTapRef.current = now
              if (tapStartedVisibleRef.current) {
                if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current)
                setShowControls(false)
              } else {
                setShowControls(true)
                armHide()
              }
            }
          } else {
            togglePlay()
          }
        }}
        onDoubleClick={toggleFullscreen}
      />
      {status === 'ready' && (
        <div className={`ui-controls ${!showControls && !paused ? 'ui-hidden' : ''}`}>
          <div className="ui-progress-row">
            <div className="ui-track"><div className="ui-track-fill" style={{ width: `${(seekDragging ? seekPreview : dur > 0 ? Math.min(1000, Math.round((cur / dur) * 1000)) : 0) / 10}%` }} /></div>
            {seekDragging && dur > 0 && (
              <div className="ui-seek-bubble" style={{ left: `${seekPreview / 10}%` }}>{fmt((seekPreview / 1000) * dur)}</div>
            )}
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
            <button onClick={togglePlay} title={paused ? '播放' : '暂停'}>{paused ? I.play : I.pause}</button>
            <button onClick={() => seekBy(-10)} title="快退 10 秒">{I.back10}</button>
            <button onClick={() => seekBy(10)} title="快进 10 秒">{I.fwd10}</button>
            <span className="ui-time">{fmt(cur)} / {fmt(dur)}</span>
            <div className="ui-flex" />
            {subMenuTracks.length > 0 ? (
              <div className="ui-menu-box">
                <button
                  onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'sub' ? null : 'sub') }}
                  title="字幕"
                  className={subOn ? 'ui-on' : 'ui-off'}
                >字</button>
                {openMenu === 'sub' && (
                  <div className="ui-menu" onClick={(e) => e.stopPropagation()}>
                    <button className={`ui-menu-item ${!subOn ? 'ui-on' : ''}`} onClick={closeSub}>关闭字幕</button>
                    {subMenuTracks.map((t) => (
                      <button
                        key={t.embyIndex}
                        className={`ui-menu-item ${subOn && selectedSubEmby === t.embyIndex ? 'ui-on' : ''}`}
                        onClick={() => pickSubTrack(t.embyIndex)}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => { playerRef.current?.setSubtitleEnable(!subOn); setSubOn(!subOn) }}
                title="字幕"
                className={subOn ? 'ui-on' : 'ui-off'}
              >字</button>
            )}
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
              <button onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'speed' ? null : 'speed') }} title="倍速">倍速{rate !== 1 ? ` ${rate}×` : ''}</button>
              {openMenu === 'speed' && (
                <div className="ui-menu" onClick={(e) => e.stopPropagation()}>
                  {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((r) => (
                    <button key={r} className={`ui-menu-item ${rate === r ? 'ui-on' : ''}`} onClick={() => { changeRate(r); setOpenMenu(null) }}>
                      {r}×{rate === r ? ' ✓' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={toggleMute} title="静音">{muted || volume === 0 ? I.volOff : I.vol}</button>
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
            <button onClick={toggleFullscreen} title="全屏">{I.fs}</button>
          </div>
        </div>
      )}
      {status === 'ready' && startedRef.current && !gotFirstFrame && !paused && (
        <div className="ui-warmup">软解启动中,首次出画面可能需要几秒…</div>
      )}
      {audioDead && status === 'ready' && !paused && (
        <button
          className="ui-audiohint"
          onClick={(e) => {
            e.stopPropagation()
            recoverAudioCtx()
            smartPlay()
            setAudioDead(false)
          }}
        >
          🔇 点击开启声音并继续播放
        </button>
      )}
      {seekFlash && (
        <div
          className="ui-seek-flash"
          style={{ left: seekFlash.side === 'l' ? '25%' : '75%' }}
        >
          {seekFlash.side === 'l' ? '⏪ 快退 10 秒' : '快进 10 秒 ⏩'}
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
              <div className="ui-diag-sec">码率(片源)</div>
              <div className="ui-diag-v strong">{diag.mbps} Mbps</div>
              <div className="ui-diag-v dim">下折线为实时吞吐(缓冲满时趋近 0 属正常)</div>
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
