/**
 * Emby DeviceProfile:告诉服务器"我能直接播什么"。
 * 声明得越准,服务器越倾向于 DirectPlay(原始文件直链,零转码)。
 * 音频/容器不支持时服务器会自动降级为 remux(视频拷贝、只处理音频,CPU 极低)
 * 或完整转码(最后手段)。
 */
export function buildDeviceProfile(supportsAc3: boolean) {
  const audio = ['aac', 'mp3', 'flac', 'opus', 'vorbis', 'dts', 'dca']
  if (supportsAc3) audio.push('ac3', 'eac3')

  return {
    MaxStreamingBitrate: 140000000,
    MaxStaticBitrate: 140000000,
    MusicStreamingTranscodingBitrate: 320000,

    DirectPlayProfiles: [
      { Container: 'mkv', Type: 'Video', VideoCodec: 'h264,hevc,av1,vp9', AudioCodec: audio.join(',') },
      { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: 'h264,hevc,av1,vp9', AudioCodec: audio.join(',') },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'opus,vorbis' },
      { Container: 'mp3,flac,ogg,m4a', Type: 'Audio', AudioCodec: audio.join(',') },
    ],

    TranscodingProfiles: [
      // 音频兜底档:视频一律拷贝(源视频编码在 VideoCodec 里即不重编码),
      // 仅音频转 AAC——TrueHD/DTS-HD 等浏览器无法解码的音轨走这里,服务器 CPU 个位数
      {
        Container: 'mkv',
        Type: 'Video',
        Protocol: 'http',
        VideoCodec: 'h264,hevc,av1,vp9',
        AudioCodec: 'aac',
        Context: 'Streaming',
      },
      {
        Container: 'mp4',
        Type: 'Video',
        Protocol: 'http',
        VideoCodec: 'h264,hevc',
        AudioCodec: 'aac,mp3',
        Context: 'Streaming',
        BreakOnNonKeyFrames: true,
      },
      { Container: 'ts', Type: 'Video', Protocol: 'http', VideoCodec: 'h264', AudioCodec: 'aac,mp3', Context: 'Streaming' },
      { Container: 'aac', Type: 'Audio', Protocol: 'http', AudioCodec: 'aac', Context: 'Streaming' },
    ],

    // 只声明 External(服务器把文本字幕抽出来单独发),
    // 不声明 Encode(烧录字幕),避免服务器为了字幕而转码视频。
    SubtitleProfiles: [
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'vtt', Method: 'External' },
    ],
  }
}

/** Edge 对 AC3/EAC3 有系统级解码支持,Chrome 桌面版大多没有 —— 启动时探测一次 */
export function detectAc3Support(): boolean {
  try {
    const v = document.createElement('video')
    return (
      v.canPlayType('audio/mp4; codecs="ac-3"') !== '' ||
      v.canPlayType('video/mp4; codecs="ac-3"') !== ''
    )
  } catch {
    return false
  }
}

/**
 * 客户端本地可解码的音频编码矩阵(与 public/wasm 的实际解码器对齐):
 * - 浏览器原生:aac/mp3/flac/opus/vorbis(MSE/原生 video)
 * - libmedia wasm:ac3/eac3/dca(DTS)/mp2(降级软解)
 * TrueHD/MLP 官方无 wasm 解码器 → 不在矩阵内 → 走服务器仅音频转码兜底。
 */
export const LOCAL_AUDIO_CODECS = new Set([
  'aac', 'mp3', 'flac', 'opus', 'vorbis',
  'ac3', 'eac3', 'dca', 'dts', 'mp2', 'mp3float',
  'pcm_s16le', 'pcm_s24le', 'pcm_bluray',
])

/** 判断音频编码是否本地可解(AAC 需浏览器都支持,视为恒可解) */
export function isAudioLocallyDecodable(codec: string | undefined, supportsAc3: boolean): boolean {
  if (!codec) return true
  const c = codec.toLowerCase().trim()
  if (LOCAL_AUDIO_CODECS.has(c)) {
    // ac3/eac3 恒可解:wasm 有解码器,不依赖浏览器探测
    return true
  }
  return false
}
