# Emby 直连播放器

一个纯前端的 Emby 第三方 Web 播放器。核心目标:**播放时服务器零转码、浏览器原画直连**——4K HEVC 原盘用 WebAssembly 多线程软解也能实时播放,类似商业站点的"网页端原盘直连"体验。

> 纯静态单页应用,登录你自己的 Emby 即用;不经过任何第三方后端。

## 特性

- **纯直连策略**:任何文件永远先原样直连(`stream.mkv?Static=true`),不自动降画质、不自动转码;服务器零 CPU
- **三管线播放内核**(基于 [libmedia](https://github.com/zhaohappy/libmedia)):
  - WebCodecs 硬解(有硬解时首选,最低功耗)
  - MSE 原生通道(HDR 内容直通,避免色彩映射错误)
  - WebAssembly 软解(无硬解时兜底;配合 COOP/COEP 多线程,4K HEVC 实时可跑)
- **智能降级链**:mp4 → 原生 `<video>`;MSE 打不开 → canvas 管线;极端情况 → 纯 wasm 重建;每级失败自动下沉,启动看门狗 + 播放中停滞自愈
- **字幕**:
  - 文本字幕(ASS/SSA/SRT)由 [JASSUB](https://github.com/YouTube-Extension/JASSUB)(libass 的 wasm 版)渲染,
    特效字幕完整还原;JASSUB 不可用时自动回退 libmedia 内置渲染,字幕始终可见
  - PGS/DVB 位图字幕由 libmedia 原生渲染(libass 画不了位图)
  - 内嵌字幕走 Emby 提取接口,外挂字幕直接读文件;SRT 统一归一化为 ASS
  - **字体必须给 JASSUB 喂 TTF/OTF**:其内嵌 freetype 解不了 woff2(静默零字形、字幕整条不显示);
    `public/fonts/` 同时提供 woff2(浏览器 CSS 用)与 ttf(libass 用)两种格式
- **字体兜底**:自托管思源黑体子集(woff2)+ 浏览器本机字体(Local Font Access),字幕不再豆腐块
- **Emby 集成**:登录(38 位以上设备标识)、媒体库/详情/剧集列表、播放进度上报、断点续播、看完标记
- **网络**:按内容码率自适应首段 Range 预载(8–64MB),减少碎片请求

## 播放链路

```
PlaybackInfo(DeviceProfile 声明直连能力)
  └─> 容器判定
       ├─ mp4/m4v ──────────────> 原生 <video> 渐进直连
       │     └─ 解不动(如 HEVC-in-MP4)─> 换 libmedia 引擎直连
       └─ mkv/其它 ─────────────> libmedia 引擎
             ├─ MSE 可行 ──────> 原生解码(含 HDR 直通)
             └─ 不可行 ────────> canvas 管线(WebCodecs 硬解 → wasm 软解)
                   └─ 仍失败 ──> 纯 wasm 软解重建
```

右上角徽标实时显示当前管线:直连·硬解 / 直连·MSE(HDR) / 直连·软解。

## 一个关键的 libmedia 补丁(欢迎 review)

**现象**:部分 AAC 5.1 多声道 MKV(声道布局未声明)在 libmedia 下永远黑屏,控制台报
`open audio decoder failed, ret: -28`。ffmpeg 本体解同一条流毫无问题。

**根因**:libmedia 的 MKV demuxer 对这类轨写出的 `AVCodecParameters.chLayout` 无效
(`nbChannels = -1`),官方 wasm AAC 解码器 `avcodec_open2` 直接拒绝,起播被整体卡死。

**修复**(`src/player/engine.ts`):
1. 传入 `findBestStream` 回调(libmedia 在选流后、解码器 open 时才序列化 codecpar,时序正好);
2. dist 产物里 `stream.codecpar` 是裸堆地址(libmedia 的指针访问靠编译期改写,用户侧拿到的是 number),
   必须经 `player.getStreams()` 返回的 `codecparProxy`(`accessof` 包装的结构体实例)读写同一块堆内存;
3. 用 Emby 元数据里的真实声道数(`MediaStream.Channels`)把无效声道修复成标准布局
   (6 声道 → 5.1 掩码),wasm 解码器随即正常打开。

另有一处易踩坑:`formatContext.streams` 里混着字幕字体附件流(一部番 112 条流很正常),
选流时需按 `codecType` 过滤,不能用下标假设。

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173
```

登录页填你的 Emby 地址。注意跨域:生产部署建议把本播放器放在与 Emby 同域的反代路径下
(浏览器对 Emby API 的跨域策略随版本变化,同域部署最稳)。

## 构建与部署

```bash
npm run build -- --base=/stream/   # 子路径部署时必须带 --base
# 产物在 dist/,wasm 与字体已在 public/ 内、随构建拷贝
```

Nginx/OpenResty 参考配置(多线程软解必须带 COOP/COEP 响应头):

```nginx
location /stream/ {
    alias /your/site/path/stream/;
    try_files $uri $uri/ /stream/index.html;
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy credentialless always;
}
```

部署完成后访问 `https://your-domain/stream/`。媒体流与 Emby API 走同域即可。

## 目录结构

```
src/
  api/            Emby REST 封装(登录/PlaybackInfo/进度上报/字幕提取)
  player/
    engine.ts     libmedia AVPlayer 胶水层(管线选择/降级链/codecpar 补丁)
    native.ts     mp4 原生 <video> 引擎
  pages/          Login / Home / Detail / Player
public/
  wasm/           libmedia v1.3.1 官方解码器(15 编解码器 × 4 变体,按浏览器特性自选)
  fonts/          思源黑体子集 woff2 + 字体映射 fonts.json
tools/            子集化字体源文件(不入库,构建可选)
```

## 二进制资源与许可

- `public/wasm/`:取自 [libmedia](https://github.com/zhaohappy/libmedia) v1.3.1 官方发布产物(LGPL-3.0),
  未做任何修改;本播放器不包含、不链接任何 x264/x265 等 GPL 编码器
- [JASSUB](https://github.com/YouTube-Extension/JASSUB):libass 的 WebAssembly 封装
- `public/fonts/`:[思源黑体](https://github.com/adobe-fonts/source-han-sans)(SIL OFL 1.1)子集化产物

本项目代码以 MIT 许可发布(见 LICENSE)。

## 免责声明

仅供个人学习与研究,请连接自己有权限的 Emby 服务器使用;与 Emby 官方无关。
