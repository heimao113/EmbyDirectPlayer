// 与 Emby 服务端交互用到的最小类型定义(字段按需声明,未列出的字段运行时仍然存在)

export interface MediaStream {
  Index: number
  Type: 'Video' | 'Audio' | 'Subtitle'
  Codec?: string
  Language?: string
  DisplayTitle?: string
  Title?: string
  IsDefault?: boolean
  IsExternal?: boolean
  IsTextSubtitleStream?: boolean
  SupportsExternalStream?: boolean
  IndexNumber?: number
  BitRate?: number
  /** 音频:声道数(修复 libmedia demuxer 无效声道用) */
  Channels?: number
  /** 视频:分辨率高(像素) */
  Height?: number
  /** 视频:分辨率宽(像素) */
  Width?: number
  /** 视频:色彩传输特性(SDR/HDR 判断用,如 smpte2084/ARIB-STD-B67) */
  ColorTransfer?: string
  DeliveryMethod?: string
  DeliveryUrl?: string
  DisplayLanguage?: string
}

export interface MediaSource {
  Id: string
  Name?: string
  Path?: string
  Container?: string
  Protocol?: string
  Size?: number
  Bitrate?: number
  OriginalTitle?: string
  RunTimeTicks?: number
  MediaStreams?: MediaStream[]
  SupportsDirectPlay?: boolean
  SupportsDirectStream?: boolean
  SupportsTranscoding?: boolean
  TranscodingUrl?: string
  TranscodingSubProtocol?: string
  TranscodingContainer?: string
  DefaultAudioStreamIndex?: number
  DefaultSubtitleStreamIndex?: number
}

export interface UserItemData {
  PlaybackPositionTicks?: number
  PlayedPercentage?: number
  Played?: boolean
  UnplayedItemCount?: number
  LastPlayedDate?: string
}

export interface BaseItem {
  Id: string
  Name: string
  Type: string
  SeriesName?: string
  SeriesId?: string
  SeasonId?: string
  ParentIndexNumber?: number
  IndexNumber?: number
  ProductionYear?: number
  OfficialRating?: string
  CommunityRating?: number
  Overview?: string
  Genres?: string[]
  OriginalTitle?: string
  RunTimeTicks?: number
  Container?: string
  MediaType?: string
  ImageTags?: Record<string, string>
  BackdropImageTags?: string[]
  UserData?: UserItemData
  MediaSources?: MediaSource[]
  ChildCount?: number
}

export interface PlaybackInfoResponse {
  PlaySessionId?: string
  MediaSources?: MediaSource[]
  ErrorCode?: string
}

export interface AuthResult {
  AccessToken: string
  ServerId?: string
  User: { Id: string; Name: string; Policy?: unknown }
}

export interface QueryParams {
  [key: string]: string | number | boolean | undefined
}
