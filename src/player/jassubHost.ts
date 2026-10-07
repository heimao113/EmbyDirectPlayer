/**
 * JASSUB(libass 的 WebAssembly 版)字幕宿主。
 *
 * 文本字幕(ASS/SSA/SRT)的渲染从这里走 libass,还原度高于 libmedia
 * 内置的 assjs DOM 渲染;PGS/DVB 位图字幕仍由 libmedia 原生渲染(libass 画不了)。
 *
 * 生命周期纪律(上一版方案因"实例生命周期竞态"被弃用,本次的处理):
 * - 宿主与播放器引擎实例一一对应:引擎重建/换片/关字幕必须先 detach(),
 *   确保 rAF 驱动循环、worker、overlay canvas 三者一起销毁;
 * - attach 内部先 detach 再挂新实例,并用自增序号丢弃迟到回调,
 *   旧实例的任何异步收尾都不会污染新实例。
 */
import JASSUB from 'jassub'


export interface JassubAttachOptions {
  /** 渲染面容器(.player-surface),overlay canvas 挂这里 */
  surface: HTMLElement
  /** 归一化后的 ASS 全文 */
  assContent: string
  availableFonts: Record<string, string>
  defaultFont: string
  /** MSE/原生引擎的 <video>:传了就走 rvfc 自驱渲染,无需外部驱动 */
  video?: HTMLVideoElement
  /** canvas 管线(软解/硬解)的时间源:当前播放秒数 */
  getSec?: () => number
  /** 视频源分辨率(ASS PlayRes 缩放的基准),canvas 管线必传 */
  videoWidth?: number
  videoHeight?: number
  /** MKV 内嵌字体(附件流原始字节),libass 按字体内部名匹配 Style 引用 */
  fonts?: Uint8Array[]
}

export class JassubHost {
  private inst: JASSUB | null = null
  private canvas: HTMLCanvasElement | null = null
  private raf = 0
  private seq = 0
  private ro: ResizeObserver | null = null
  /** 诊断用:'attaching' | 'ready' | 'failed' + 失败原因 */
  private state: 'idle' | 'attaching' | 'ready' | 'failed' = 'idle'
  private lastErr = ''

  getStatus(): { state: 'idle' | 'attaching' | 'ready' | 'failed'; lastErr: string } {
    return { state: this.state, lastErr: this.lastErr }
  }

  get active(): boolean {
    return this.inst !== null
  }

  async attach(o: JassubAttachOptions): Promise<void> {
    await this.detach()
    this.state = 'attaching'
    this.lastErr = ''
    const mySeq = ++this.seq

    const canvas = document.createElement('canvas')
    canvas.className = 'jassub-overlay'
    o.surface.appendChild(canvas)
    this.canvas = canvas

    let inst: JASSUB
    try {
      inst = new JASSUB({
        ...(o.video ? { video: o.video } : {}),
        canvas,
        subContent: o.assContent,
        availableFonts: o.availableFonts,
        defaultFont: o.defaultFont,
        fonts: o.fonts,
        // workerUrl 不传:JASSUB 默认 new Worker(new URL('./worker/worker.js', import.meta.url)),
        // 由 Vite 以 es 格式打包(vite.config worker.format)——官方 worker 入口带裸导入,
        // 不能像 wasm 一样静态拷贝了直接用(那样握手会挂起:入口根本没注册消息处理)
        wasmUrl: `${import.meta.env.BASE_URL}jassub/jassub-worker.wasm`,
        modernWasmUrl: `${import.meta.env.BASE_URL}jassub/jassub-worker-modern.wasm`,
        // 本机字体查询是可选增强,worker 侧失败会拖垮整个渲染,先关掉
        queryFonts: false,
      })
    } catch (e) {
      canvas.remove()
      this.canvas = null
      this.state = 'failed'
      this.lastErr = String(e instanceof Error ? e.message : e).slice(0, 160)
      throw e
    }
    if (mySeq !== this.seq) {
      void inst.destroy().catch(() => {})
      canvas.remove()
      return
    }
    this.inst = inst
    if (o.video) return

    // canvas 管线(无 <video>):JASSUB 对 canvas 走 transferControlToOffscreen,
    // worker 侧画布尺寸停在构造时的默认值,必须 ready 后显式 resize() 校准;
    // renderer 在 ready 完成前是 undefined,绝不能提前喂数据(上次弃用的"竞态"即此)
    try {
      // ready 挂起(如 worker 握手失败/wasm 加载慢)时按超时放弃,
      // 上层回退 libmedia 原生字幕渲染,保证任何环境下字幕都可见
      const outcome = await Promise.race([
        inst.ready.then(() => 'ok' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15000)),
      ])
      if (outcome === 'timeout') throw new Error('worker ready 超时(15s)')
    } catch (e) {
      await this.detach()
      this.state = 'failed'
      this.lastErr = String(e instanceof Error ? e.message : e).slice(0, 160)
      throw e instanceof Error ? e : new Error(String(e))
    }
    this.state = 'ready'
    if (this.inst !== inst || mySeq !== this.seq) return
    await inst.resize(true)

    // 显示区变化(窗口缩放/全屏切换)时重新校准 worker 侧画布
    const ro = new ResizeObserver(() => {
      if (this.inst === inst && mySeq === this.seq) void inst.resize(true)
    })
    ro.observe(canvas)
    this.ro = ro

    const vw = o.videoWidth || 1280
    const vh = o.videoHeight || 720
    const tick = () => {
      if (this.inst !== inst || mySeq !== this.seq) return
      try {
        // width/height 传视频源尺寸(JASSUB 以此做 PlayRes 缩放),不是画布尺寸;
        // 画布已被 transferControlToOffscreen 接管,主线程禁止改 width/height
        inst.manualRender({
          expectedDisplayTime: performance.now(),
          width: vw,
          height: vh,
          mediaTime: Math.max(0, o.getSec?.() ?? 0),
        }).catch(() => {})
      } catch {
        /* 单帧渲染失败不中断循环 */
      }
      this.raf = requestAnimationFrame(tick)
    }
    tick()
  }

  async detach(): Promise<void> {
    this.seq++
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    const inst = this.inst
    this.inst = null
    if (this.state !== 'failed') this.state = 'idle'
    this.ro?.disconnect()
    this.ro = null
    if (inst) {
      try {
        await inst.destroy()
      } catch {
        /* 已销毁实例的重复 destroy 忽略 */
      }
    }
    this.canvas?.remove()
    this.canvas = null
  }
}
