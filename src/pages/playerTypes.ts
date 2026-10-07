/** 播放器与字幕模块共用的类型 */

/** Emby MediaStream 里的一条字幕轨 */
export interface SubTrack {
  index: number
  label: string
  codec: string
  isText: boolean
  /** PGS/VOBSUB/DVBSUB 位图字幕,交给 libmedia 原生渲染 */
  isGraphic: boolean
  deliveryUrl?: string
}

/** libmedia demux 出来的一条音轨(直连模式下可直接切换,无需服务器 remux) */
export interface AudioTrackOption {
  /** libmedia 流 id(selectAudio 用) */
  id: number
  /** 容器内流序号(与 Emby MediaStream.Index 对应) */
  index: number
  label: string
  codec: string
  language: string
  channels?: number
  isDefault: boolean
}
