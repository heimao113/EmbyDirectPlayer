/**
 * libmedia 播放引擎胶水层。
 *
 * 职责:
 * - 封装 AVPlayer 的生命周期/事件,转成普通回调给 React
 * - 管线识别(mse / webcodecs 硬解 / wasm 软解)
 * - 轨道枚举与切换(音轨、字幕轨;PGS 由 libmedia 原生渲染)
 * - wasmOnly 重建(纯软解降级)
 *
 * 文本字幕的渲染不在这里:由 Player.tsx 统一走 JASSUB(libass),
 * engine 只负责在 JASSUB 生效期间关掉 libmedia 自己的字幕渲染,
 * 避免双层渲染。
 */
import AVPlayer, { Events } from '@libmedia/avplayer'
import { mapUint8Array } from '@libmedia/cheap'
import { AVCodecID, AVMediaType, AVChannelOrder, AVDisposition } from '@libmedia/avutil/enum'

/** 各声道数的标准布局掩码(ffmpeg av_channel_layout_default 同款):FL=1 FR=2 FC=4 LFE=8 BL=10 BR=20 BC=100 SL=200 SR=400 */
const CHANNEL_DEFAULT_MASK: Record<number, bigint> = {
  1: 0x4n,   // mono FC
  2: 0x3n,   // stereo FL+FR
  3: 0xBn,   // 2.1 FL+FR+LFE
  4: 0x107n, // 4.0 FL+FR+FC+BC
  5: 0x37n,  // 5.0 FL+FR+FC+BL+BR
  6: 0x3Fn,  // 5.1 FL+FR+FC+LFE+BL+BR
  7: 0x70Fn, // 6.1 FL+FR+FC+LFE+BC+SL+SR
  8: 0x63Fn, // 7.1 FL+FR+FC+LFE+BL+BR+SL+SR
}

export type PipelineKind = 'mse' | 'hw' | 'sw' | 'unknown'

export interface EngineStream {
  /** libmedia 的流 id,selectAudio/selectSubtitle 用 */
  id: number
  /** 容器内流序号,与 Emby MediaStream.Index 对应 */
  index: number
  mediaType: 'video' | 'audio' | 'subtitle'
  codecId: number
  codec: string
  language: string
  title: string
  isDefault: boolean
  /** PGS/DVD/DVB 位图字幕 */
  isGraphic: boolean
  width?: number
  height?: number
  sampleRate?: number
  channels?: number
}

export interface EngineHandlers {
  onLoading?(stage: string): void
  onLoaded?(): void
  onFirstFrame?(): void
  onPlaying?(): void
  onPaused?(): void
  onEnded?(): void
  onTime?(sec: number, durationSec: number): void
  onSeeked?(): void
  onError?(err: Error): void
  onPipeline?(kind: PipelineKind, reason?: string): void
  onVolumeChange?(v: number): void
  onTrackChanged?(mediaType: 'video' | 'audio' | 'subtitle'): void
}

/** WebCodecs 硬解探测用的 codec string */
const HW_CODEC_STRING_BY_NAME: Record<string, string> = {
  h264: 'avc1.640028',
  hevc: 'hvc1.1.6.L93.B0',
  av1: 'av01.0.08M.08',
  vp9: 'vp09.00.10.08',
  vp8: 'vp8',
}

/** WebCodecs 硬解能力探测(异步,结果缓存)。codecName 如 'hevc'/'h264';WebCodecs 管不到的编码返回 null */
export async function probeHWSupport(codecName: string): Promise<boolean | null> {
  const lower = codecName.toLowerCase()
  const codec = HW_CODEC_STRING_BY_NAME[lower]
  if (!codec) return null
  const dec = (globalThis as any).VideoDecoder
  if (!dec?.isConfigSupported) {
    hwProbeByNameCache.set(lower, false)
    return false
  }
  try {
    const r = await dec.isConfigSupported({ codec })
    const ok = Boolean(r?.supported)
    hwProbeByNameCache.set(lower, ok)
    return ok
  } catch {
    hwProbeByNameCache.set(lower, false)
    return false
  }
}

const GRAPHIC_SUBTITLE_IDS = new Set<number>([
  AVCodecID.AV_CODEC_ID_HDMV_PGS_SUBTITLE,
  AVCodecID.AV_CODEC_ID_DVD_SUBTITLE,
  AVCodecID.AV_CODEC_ID_DVB_SUBTITLE,
])

const codecIdName = (id: number): string => {
  const name = (AVCodecID as Record<number | string, string | number>)[id]
  if (typeof name !== 'string') return `codec ${id}`
  return name
    .replace(/^AV_CODEC_ID_/, '')
    .replace(/^HDMV_PGS_SUBTITLE$/, 'PGS')
    .replace(/^DVD_SUBTITLE$/, 'VOBSUB')
    .replace(/^DVB_SUBTITLE$/, 'DVBSUB')
    .replace(/^DCA$/, 'DTS')
    .replace(/^MPEG2VIDEO$/, 'MPEG2')
    .replace(/^WEBVTT$/, 'WebVTT')
    .replace(/^SUBRIP$/, 'SRT')
}

// WebAssembly.validate 探测结果决定 libmedia 拉 -simd/-atomic/基础 变体,不用我们管。
// 徽标用:probeHWSupport(异步)的缓存,初始化时已预热。
const hwProbeByNameCache = new Map<string, boolean>()

export function probeHardware(codecId: number): boolean | undefined {
  const name = codecIdName(codecId).toLowerCase()
  if (!HW_CODEC_STRING_BY_NAME[name]) return undefined // WebCodecs 管不到的编码
  return hwProbeByNameCache.get(name)
}

export class Engine {
  private container: HTMLDivElement
  private player: AVPlayer | null = null
  private handlers: EngineHandlers = {}
  private wasmOnly = false
  private destroyed = false
  /** MSE 优先:强制走浏览器原生解码(最低 CPU),失败由上层回退 canvas 管线 */
  private preferMSE = false

  private noWorker = false
  /** Emby 元数据里的主音轨声道数;libmedia demuxer 对某些 AAC 轨会填出无效声道(-1) */
  private audioChannelsHint = 0

  constructor(
    container: HTMLElement,
    opts: { preferMSE?: boolean; noWorker?: boolean; audioChannelsHint?: number } = {},
  ) {
    this.container = container as HTMLDivElement
    this.preferMSE = opts.preferMSE ?? false
    this.noWorker = opts.noWorker ?? false
    this.audioChannelsHint = opts.audioChannelsHint ?? 0
  }

  get isPreferMSE(): boolean {
    return this.preferMSE
  }

  get isWasmOnly(): boolean {
    return this.wasmOnly
  }

  async create(handlers: EngineHandlers): Promise<void> {
    this.handlers = handlers
    await this.build()
  }

  /** 销毁当前实例并以纯软解模式重建(wasmOnly 降级) */
  async downgradeToWasmOnly(): Promise<void> {
    this.wasmOnly = true
    await this.rebuild()
  }

  async rebuild(): Promise<void> {
    await this.destroy()
    await this.build()
  }

  private async build(): Promise<void> {
    this.destroyed = false
    const h = this.handlers
    const player = new AVPlayer({
      container: this.container,
      // 自托管解码器:public/wasm/{decode,resample,stretchpitch}/…
      wasmBaseUrl: `${import.meta.env.BASE_URL}wasm/`,
      enableHardware: !this.wasmOnly,
      enableWebCodecs: !this.wasmOnly,
      // SharedArrayBuffer(多线程)只在跨域隔离时可用;否则 libmedia 自己降单线程
      enableWorker: globalThis.crossOriginIsolated === true && !this.noWorker,
      preLoadTime: 10,
      // MSE 优先:绕过 libmedia 保守的 MSE 判定(音轨编码不讨喜时它宁可走软解),
      // 强制尝试原生 video 通道;失败会触发 ERROR,上层回退 canvas 管线
      ...(this.preferMSE && !this.wasmOnly
        ? { checkUseMSE: () => true }
        : {}),
      findBestStream: (streams, mediaType) => {
        // formatContext.streams 里的 codecpar 是裸堆地址(libmedia 的指针访问靠
        // 编译期改写,用户回调里只是 number),必须经 getStreams() 的 codecparProxy
        // (accessof 包好的结构体实例)才能读写同一块堆内存——序列化发生在解码器
        // open 时,这里写入的值会原样传给 wasm。
        let proxies: { id: number; cp: Record<string, any> }[] = []
        try {
          proxies = (player.getStreams() as Array<Record<string, any>>).map((g) => ({
            id: g.id as number,
            cp: g.codecparProxy as Record<string, any>,
          }))
        } catch { /* getStreams 不可用则退化为只选流不改参数 */ }
        const cpOf = (id: number) => proxies.find((x) => x.id === id)?.cp
        const pool = streams.filter((s) => {
          const cp = cpOf((s as unknown as { id: number }).id)
          // 拿不到 proxy 时退回 attachment 粗滤(按 libmedia 约定 index<4 之外多为附件)
          return cp ? (cp.codecType as number) === (mediaType as number) : true
        })
        if ((mediaType as number) === AVMediaType.AVMEDIA_TYPE_AUDIO) {
          for (const s of pool) {
            const cp = cpOf((s as unknown as { id: number }).id)
            const layout = cp?.chLayout as { order: number; nbChannels: number; u: { mask: bigint } } | undefined
            if (!layout) continue
            // 官方 wasm AAC 解码器对声道布局未声明(UNSPEC)的多声道轨 open 失败
            // (ret -28)并卡死起播;ffmpeg 本体解同一条流毫无问题。把 UNSPEC 布局
            // 补成该声道数的标准布局再交给解码器。
            const nb = layout.nbChannels
            if (nb > 0 && (layout.order as number) === (AVChannelOrder.AV_CHANNEL_ORDER_UNSPEC as number)) {
              // 布局未声明但声道数有效:补该声道数的标准布局
              layout.order = AVChannelOrder.AV_CHANNEL_ORDER_NATIVE as number
              layout.u.mask = CHANNEL_DEFAULT_MASK[nb] ?? 0x63Fn
              console.warn('[ewp-engine] fixed unspec layout audio#', s.index, 'ch', nb, '-> mask', String(layout.u.mask))
            }
            else if (nb <= 0 && this.audioChannelsHint > 0) {
              // demuxer 填出无效声道(如 AAC 5.1 轨得到 -1)→ 用 Emby 元数据修复,
              // 否则 wasm 解码器 open 直接失败(-28)卡死起播
              layout.nbChannels = this.audioChannelsHint
              layout.order = AVChannelOrder.AV_CHANNEL_ORDER_NATIVE as number
              layout.u.mask = CHANNEL_DEFAULT_MASK[this.audioChannelsHint] ?? 0x63Fn
              console.warn('[ewp-engine] fixed invalid channels audio#', s.index, '-> ch', this.audioChannelsHint, 'mask', String(layout.u.mask))
            }
          }
        }
        // 沿用 libmedia 默认选流规则:default 标记优先,否则第一个
        const byDefault = pool.filter((s) => s.disposition & AVDisposition.DEFAULT)
        return (byDefault[0] ?? pool[0]) as typeof streams[number]
      },
    })
    AVPlayer.setLogLevel?.(import.meta.env.DEV ? 3 : 1)

    player.on(Events.LOADING, () => h.onLoading?.('加载中'))
    player.on(Events.LOADED, () => {
      this.emitPipeline()
      h.onLoaded?.()
    })
    player.on(Events.PLAYING, () => {
      this.pausedByEvent = false
      h.onPlaying?.()
    })
    player.on(Events.PLAYED, () => {
      this.pausedByEvent = false
      h.onPlaying?.()
    })
    player.on(Events.PAUSED, () => {
      this.pausedByEvent = true
      h.onPaused?.()
    })
    player.on(Events.STOPPED, () => {
      this.pausedByEvent = true
      h.onPaused?.()
    })
    player.on(Events.ENDED, () => h.onEnded?.())
    player.on(Events.TIME, () => h.onTime?.(this.currentSec(), this.durationSec()))
    player.on(Events.SEEKED, () => h.onSeeked?.())
    player.on(Events.ERROR, (err: Error) => h.onError?.(err))
    player.on(Events.FIRST_VIDEO_RENDERED, () => h.onFirstFrame?.())
    player.on(Events.VOLUME_CHANGE, (v: number) => h.onVolumeChange?.(v))
    player.on(Events.CHANGED, (type: number) => {
      const mediaType =
        type === AVMediaType.AVMEDIA_TYPE_VIDEO
          ? 'video'
          : type === AVMediaType.AVMEDIA_TYPE_AUDIO
            ? 'audio'
            : 'subtitle'
      h.onTrackChanged?.(mediaType)
    })

    this.player = player
  }

  private emitPipeline(): void {
    const p = this.player
    if (!p) return
    if (p.isMSE?.()) {
      this.handlers.onPipeline?.('mse')
      return
    }
    const video = this.streams().find((s) => s.mediaType === 'video')
    const hw = video ? probeHardware(video.codecId) : undefined
    this.handlers.onPipeline?.(hw === true && !this.wasmOnly ? 'hw' : 'sw')
  }

  /** 当前渲染面:MSE 路径是 <video>,软解/硬解路径是 canvas */
  attachPoint(): { video?: HTMLVideoElement; canvas?: HTMLCanvasElement } {
    const video = this.container.querySelector('video') as HTMLVideoElement | null
    if (video) return { video }
    const canvas = this.container.querySelector('canvas') as HTMLCanvasElement | null
    return canvas ? { canvas } : {}
  }

  async load(
    url: string,
    opts: { ext?: string; isLive?: boolean; preloadBytes?: number } = {},
  ): Promise<void> {
    if (!this.player) throw new Error('engine not created')
    await this.player.load(url, {
      ...(opts.ext ? { ext: opts.ext } : {}),
      ioLoaderOptions: {
        // uhd 同款:按码率预载首段(约 20 秒的量),慢网/抖动多重试,读超时 20s
        ...(opts.preloadBytes ? { preload: opts.preloadBytes } : {}),
        retryCount: 30,
        retryInterval: 2,
        readTimeout: 20,
      } as never,
    })
  }

  async play(): Promise<void> {
    await this.player?.play({ audio: true, video: true, subtitle: true })
  }

  private enginePaused = false

  async pause(): Promise<void> {
    await this.player?.pause()
    this.enginePaused = true
  }

  async togglePlay(): Promise<void> {
    // 不依赖 PAUSED/PLAYING 事件(canvas 管线不保证触发),以引擎自己的状态为准
    if (this.enginePaused) await this.playResume()
    else await this.pause()
  }

  private pausedByEvent = true

  async resume(): Promise<void> {
    await this.playResume()
  }

  /** 恢复播放:必须走 play(),libmedia 的 resume() 在 canvas 管线不会重启渲染线程 */
  private async playResume(): Promise<void> {
    await this.player?.play()
    this.enginePaused = false
  }

  /**
   * 收集 MKV 内嵌字体附件(demux 出来的 ATTACHMENT 流),拷贝出 cheap 堆交给
   * JASSUB——某些字幕组的 ASS 引用内嵌字体(文件名乱码),不喂这些字体样式全丢。
   */
  embeddedFonts(): Uint8Array[] {
    const p = this.player
    if (!p) return []
    const fonts: Uint8Array[] = []
    let total = 0
    try {
      for (const g of p.getStreams() as Array<Record<string, unknown>>) {
        const cp = g.codecparProxy as Record<string, unknown> | undefined
        if (!cp || (Number(cp.codecType) !== 4)) continue // AVMEDIA_TYPE_ATTACHMENT
        const size = Number(cp.extradataSize ?? 0)
        if (size < 128 || total + size > 96 * 1024 * 1024) continue
        try {
          const view = mapUint8Array(cp.extradata as never, size)
          const copy = new Uint8Array(view)
          fonts.push(copy)
          total += size
        } catch { /* 单个附件读取失败忽略 */ }
      }
    } catch { /* getStreams 不可用 */ }
    return fonts
  }

  async seek(sec: number): Promise<void> {
    if (!this.player) return
    const clamped = Math.max(0, sec)
    // v1.3.1 内部时间单位是毫秒(与 currentTime 一致;官方文档写的 µs 是旧版行为)
    await this.player.seek(BigInt(Math.round(clamped * 1000)))
  }

  currentSec(): number {
    if (!this.player) return 0
    try {
      // v1.3.1 的 currentTime/MSE 路径都是毫秒
      return Number(this.player.currentTime) / 1000
    } catch {
      return 0
    }
  }

  /** 已缓冲到的秒数(MSE 模式读 video.buffered;自渲染管线无此数据返回 null) */
  bufferedSec(): number | null {
    const p = this.player
    if (!p) return null
    try {
      if (p.isMSE?.()) {
        const v = (this.container.querySelector('video') as HTMLVideoElement | null)
        if (v && v.buffered.length > 0) return v.buffered.end(v.buffered.length - 1)
        return null
      }
      return null
    } catch {
      return null
    }
  }

  durationSec(): number {
    if (!this.player) return 0
    try {
      const d = this.player.getDuration()
      return d > 0n ? Number(d) / 1000 : 0
    } catch {
      return 0
    }
  }

  setVolume(v: number): void {
    this.player?.setVolume(v)
  }

  getVolume(): number {
    try {
      return this.player?.getVolume() ?? 1
    } catch {
      return 1
    }
  }

  setRate(rate: number): void {
    this.player?.setPlaybackRate(rate)
  }

  streams(): EngineStream[] {
    const p = this.player
    if (!p) return []
    let raw: ReturnType<AVPlayer['getStreams']>
    try {
      raw = p.getStreams()
    } catch {
      return []
    }
    return raw.map((s) => {
      const cp = s.codecparProxy as any
      const codecId = Number(cp?.codecId ?? -1)
      const mediaTypeValue = Number(cp?.codecType)
      const mediaType: EngineStream['mediaType'] =
        mediaTypeValue === AVMediaType.AVMEDIA_TYPE_VIDEO
          ? 'video'
          : mediaTypeValue === AVMediaType.AVMEDIA_TYPE_AUDIO
            ? 'audio'
            : 'subtitle'
      return {
        id: s.id,
        index: s.index,
        mediaType,
        codecId,
        codec: codecIdName(codecId),
        language: String(s.metadata?.language ?? ''),
        title: String(s.metadata?.title ?? ''),
        isDefault: Boolean((s.disposition ?? 0) & 0x1),
        isGraphic:
          mediaType === 'subtitle' &&
          (GRAPHIC_SUBTITLE_IDS.has(codecId) || codecId === AVCodecID.AV_CODEC_ID_HDMV_PGS_SUBTITLE),
        width: cp?.width > 0 ? cp.width : undefined,
        height: cp?.height > 0 ? cp.height : undefined,
        sampleRate: cp?.sampleRate > 0 ? cp.sampleRate : undefined,
        channels: cp?.chLayout?.nbChannels > 0 ? cp.chLayout.nbChannels : undefined,
      }
    })
  }

  async selectAudio(id: number): Promise<void> {
    await this.player?.selectAudio(id)
  }

  async selectVideo(id: number): Promise<void> {
    await this.player?.selectVideo(id)
  }

  /** 播放链路面板用:统计快照(码率/解码帧率/丢帧/关键帧间隔) */
  statsSnapshot(): {
    videoBitrateKbps: number
    audioBitrateKbps: number
    videoDecodeFps: number
    videoRenderFps: number
    videoDropFrames: number
    keyFrameInterval: number
    width: number
    height: number
    rxBytes: number
  } | null {
    const p = this.player
    if (!p) return null
    try {
      const s = p.getStats()
      return {
        videoBitrateKbps: Math.round(Number(s.videoBitrate ?? 0) / 1000),
        audioBitrateKbps: Math.round(Number(s.audioBitrate ?? 0) / 1000),
        videoDecodeFps: Math.round(Number(s.videoDecodeFramerate ?? 0)),
        videoRenderFps: Math.round(Number(s.videoRenderFramerate ?? 0)),
        videoDropFrames: Number(s.videoFrameDropCount ?? 0),
        keyFrameInterval: Number(s.keyFrameInterval ?? 0),
        rxBytes: Number(s.bufferReceiveBytes ?? 0),
        width: Number(s.width ?? 0),
        height: Number(s.height ?? 0),
      }
    } catch {
      return null
    }
  }

  /** 视频解码线程信息(硬解状态/实时帧率);无 WebCodecs 时返回 null */
  decoderInfo(): { codec: string; width: number; height: number; framerate: number; hardware: boolean } | null {
    const p = this.player as any
    if (!p) return null
    try {
      const list = p.VideoDecoderThread?.getTasksInfo?.()
      const t = list?.[0]
      if (!t) return null
      return {
        codec: codecIdName(Number(t.codecId ?? -1)),
        width: Number(t.width ?? 0),
        height: Number(t.height ?? 0),
        framerate: Math.round(Number(t.framerate ?? 0)),
        hardware: Boolean(t.hardware),
      }
    } catch {
      return null
    }
  }

  async selectSubtitle(id: number): Promise<void> {
    await this.player?.selectSubtitle(id)
  }

  /** 加载外挂字幕(转码通道时内嵌轨不可用,走 Emby 提取的文本),返回 libmedia 分配的流 id */
  async loadExternalSubtitle(sub: { source: File | string; lang?: string; title?: string }): Promise<number> {
    if (!this.player) throw new Error('engine not created')
    return this.player.loadExternalSubtitle(sub)
  }

  selectedAudioId(): number | null {
    try {
      const id = this.player?.getSelectedAudioStreamId()
      return id === undefined || id < 0 ? null : id
    } catch {
      return null
    }
  }

  selectedSubtitleId(): number | null {
    try {
      const id = this.player?.getSelectedSubtitleStreamId()
      return id === undefined || id < 0 ? null : id
    } catch {
      return null
    }
  }

  selectedVideoId(): number | null {
    try {
      const id = this.player?.getSelectedVideoStreamId()
      return id === undefined || id < 0 ? null : id
    } catch {
      return null
    }
  }

  /** 关掉 libmedia 自己的字幕渲染(JASSUB 接管时用),PGS 走 libmedia 时再打开 */
  async setNativeSubtitleEnabled(enable: boolean): Promise<void> {
    try {
      this.player?.setSubtitleEnable(enable)
    } catch {
      /* 部分状态下降级忽略 */
    }
  }

  async destroy(): Promise<void> {
    const p = this.player
    this.player = null
    if (p) {
      try {
        await p.destroy()
      } catch {
        /* ignore */
      }
    }
    this.container.replaceChildren()
    this.destroyed = true
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}
