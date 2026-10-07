/**
 * 原生播放引擎:<video> + hls.js(仅用于转码 HLS 流)。
 * libmedia 对个别文件存在主线程同步死循环(无错误、无事件、页面冻结),
 * 转码输出是标准 HLS,用原生 video 播放 100% 稳定——这是 Emby 官方/jellyfin
 * 的同款方案。接口与 Engine 对齐,Player 可无感切换。
 */
import Hls from 'hls.js'
import type { EngineStream } from './engine'

export interface NativeHandlers {
  onLoaded?(): void
  onFirstFrame?(): void
  onPlaying?(): void
  onPaused?(): void
  onEnded?(): void
  onTime?(sec: number): void
  onError?(err: Error): void
  onVolumeChange?(v: number): void
  onTrackChanged?(): void
}

export class NativeEngine {
  private container: HTMLDivElement
  private video: HTMLVideoElement | null = null
  private hls: Hls | null = null
  private handlers: NativeHandlers = {}
  private pausedByEvent = true

  constructor(container: HTMLElement) {
    this.container = container as HTMLDivElement
  }

  get isWasmOnly() { return false }
  get isPreferMSE() { return false }
  isMSE() { return true } // 原生 video,统计口径与 MSE 一致

  async create(handlers: NativeHandlers): Promise<void> {
    this.handlers = handlers
    const video = document.createElement('video')
    video.playsInline = true
    video.style.cssText = 'width:100%;height:100%;display:block;'
    this.container.replaceChildren(video)
    this.video = video

    video.addEventListener('loadedmetadata', () => {
      this.pausedByEvent = false
      handlers.onLoaded?.()
      handlers.onFirstFrame?.()
    })
    video.addEventListener('timeupdate', () => handlers.onTime?.(video.currentTime))
    video.addEventListener('play', () => { this.pausedByEvent = false; handlers.onPlaying?.() })
    video.addEventListener('pause', () => { this.pausedByEvent = true; handlers.onPaused?.() })
    video.addEventListener('ended', () => handlers.onEnded?.())
    video.addEventListener('volumechange', () => handlers.onVolumeChange?.(video.muted ? 0 : video.volume))
    video.addEventListener('error', () => {
      const code = video.error?.code ?? 0
      handlers.onError?.(new Error(
        code === 4 ? '此浏览器无法解码该视频(如 HEVC 需系统解码支持)' : `视频加载失败(错误码 ${code})`,
      ))
    })
  }

  /** 码率提示(用于估算缓冲字节数) */
  private bitrateHint = 0
  setBitrateHint(bps: number): void { this.bitrateHint = bps }

  async load(url: string, _opts: { progressive?: boolean } = {}): Promise<void> {
    const video = this.video
    if (!video) throw new Error('native engine not ready')
    // 以 URL 特征自动判断:m3u8 → hls.js;其余(mp4 直连等)→ 渐进式原生播放
    const isHls = /\.m3u8($|\?)/i.test(url)
    if (!isHls) {
      video.src = url // 渐进式直连:浏览器原生 Range 播放
      return
    }
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) this.handlers.onError?.(new Error(`HLS 加载失败:${data.details ?? ''}`))
      })
      hls.loadSource(url)
      hls.attachMedia(video)
      this.hls = hls
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
    } else {
      throw new Error('浏览器不支持 HLS 播放')
    }
  }

  async play(): Promise<void> { await this.video?.play().catch(() => {}) }
  async pause(): Promise<void> { this.video?.pause() }
  async resume(): Promise<void> { await this.video?.play().catch(() => {}) }
  async togglePlay(): Promise<void> {
    const v = this.video
    if (!v) return
    if (v.paused) await v.play().catch(() => {})
    else v.pause()
  }

  seek(sec: number): void {
    if (this.video && isFinite(sec)) this.video.currentTime = Math.max(0, sec)
  }
  currentSec(): number { return this.video?.currentTime ?? 0 }
  durationSec(): number { const d = Number(this.video?.duration ?? NaN); return isFinite(d) ? d : 0 }
  bufferedSec(): number | null {
    const v = this.video
    if (v && v.buffered.length > 0) return v.buffered.end(v.buffered.length - 1 as number)
    return null
  }
  setVolume(v: number): void { if (this.video) { this.video.volume = v; this.video.muted = v === 0 } }
  getVolume(): number { return this.video?.volume ?? 1 }
  setRate(r: number): void { if (this.video) this.video.playbackRate = r }

  streams(): EngineStream[] { return [] }
  async selectAudio(): Promise<void> { /* HLS 单音轨 */ }
  async selectSubtitle(): Promise<void> { /* 转码流无独立字幕轨 */ }
  async setNativeSubtitleEnabled(enable: boolean): Promise<void> {
    const t = this.subtitleTrack
    if (t) t.mode = enable ? 'showing' : 'hidden'
  }

  /** 挂载 VTT 字幕(文本轨) */
  setTextTrackVtt(vtt: string, label = '字幕'): void {
    const v = this.video
    if (!v) return
    try {
      const track = v.addTextTrack('subtitles', label, 'zh')
      const lines = vtt.replace(/\r/g, '').split('\n')
      let last: [number, number] | null = null
      const hms = (t: string) => {
        const [h, m, rest] = t.split(':')
        const [sec] = rest.split('.')
        return Number(h) * 3600 + Number(m) * 60 + Number(sec) + Number('0.' + (rest.split('.')[1] ?? '0'))
      }
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/)
        if (!m) continue
        const start = hms(`${m[1]}:${m[2]}:${m[3]}.${m[4]}`)
        const end = hms(`${m[5]}:${m[6]}:${m[7]}.${m[8]}`)
        const text: string[] = []
        let j = i + 1
        while (j < lines.length && lines[j].trim() !== '' && !lines[j].includes('-->')) {
          text.push(lines[j].replace(/<[^>]*>/g, ''))
          j++
        }
        if (text.length && end > start) {
          track.addCue(new VTTCue(start, end, text.join('\n')))
          last = [start, end]
        }
        i = j - 1
      }
      this.subtitleTrack = track
      track.mode = 'showing'
    } catch (e) {
      console.warn('VTT 字幕轨挂载失败', e)
    }
  }
  private subtitleTrack: TextTrack | null = null
  selectedAudioId(): number | null { return null }
  selectedSubtitleId(): number | null { return null }
  selectedVideoId(): number | null { return null }
  statsSnapshot(): {
    bufferedSec: number
    audioDecodeFps: number
    audioRenderFps: number
    videoBitrateKbps: number
    audioBitrateKbps: number
    videoDecodeFps: number
    videoRenderFps: number
    videoDropFrames: number
    keyFrameInterval: number
    width: number
    height: number
    rxBytes: number
  } {
    const bsec = this.bufferedSec() ?? 0
    const brBps = this.bitrateHint > 0 ? this.bitrateHint : 2_500_000
    return {
      bufferedSec: bsec,
      videoBitrateKbps: Math.round(brBps / 1000),
      audioBitrateKbps: Math.round((this.audioBitrateKbpsHint ?? 0) / 1000),
      videoDecodeFps: 0,
      videoRenderFps: 0,
      videoDropFrames: 0,
      keyFrameInterval: 0,
      width: Math.round(bsec * (brBps / 8)),
      height: 0,
      rxBytes: Math.round(bsec * (brBps / 8)),
      audioDecodeFps: 0,
      audioRenderFps: 0,
    }
  }
  private audioBitrateKbpsHint = 0
  setBitrateHints(videoBps: number, audioBps: number): void {
    this.bitrateHint = videoBps
    this.audioBitrateKbpsHint = audioBps
  }
  decoderInfo(): null { return null }

  async destroy(): Promise<void> {
    try { this.hls?.destroy() } catch { /* ignore */ }
    this.hls = null
    this.container.replaceChildren()
  }
}
