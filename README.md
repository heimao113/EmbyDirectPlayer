# 动漫一生推 — Emby 直连播放器

一个纯前端的 Emby 第三方 Web 播放器。核心目标:**服务器零转码、浏览器原画直连**——
播放时源文件原样输出(`stream.mkv?Static=true`),视频解码全部发生在浏览器端,
源站只做文件 IO,多人在看也不吃 CPU。

> 纯静态单页应用(React + Vite),登录你自己的 Emby 即用,不经过任何第三方后端。

## 功能特性

### 播放内核([libmedia](https://github.com/zhaohappy/libmedia) 三管线)
- **原画直连优先**:所有容器永远先直连,不自动降画质;视频原样传输
- **三管线自动降级**:WebCodecs 硬解 → MSE 原生(HDR 直通)→ WebAssembly 软解,
  按 `VideoDecoder.isConfigSupported` 预热探测,失败自动下沉并重建播放器
- **多线程软解**:页面带 COOP/COEP 响应头解锁 `SharedArrayBuffer`,4K HEVC 软解实时可跑
- **AAC 5.1 黑屏修复**:libmedia demuxer 对部分 AAC 轨道写出的声道布局非法(-1 声道),
  播放前通过 `findBestStream` 回调 + `codecparProxy` 直接改写堆内存为标准布局
- **看门狗自愈**:视频停滞 / 音频渲染停滞双看门狗,自动重载恢复;
  慢线路 20 秒启动宽限,重载后重新挂载外挂字幕(保证各线路字幕表现一致)
- **自适应预载**:按内容码率决定首段 Range 预载量(8–64 MB)

### 字幕
- 文本字幕(ASS/SSA/SRT/VTT/TTML)统一**固定格式渲染**:思源黑体、底部居中、双语按行堆叠
- 字幕内容经 Emby 提取接口无条件获取,不依赖 demuxer 对内封字幕轨的解包能力
- PGS/DVB 位图字幕由 libmedia 原生绘制
- 自托管思源黑体子集(woff2 给 CSS / ttf 给 libass)+ 浏览器本机字体兜底,告别豆腐块
- 日文事件行可按偏好剥离(纯中文模式)

### 站点功能
- UHD 式首页:全屏 Hero 大图(推荐内容从指定媒体库**随机抽取**)+ 缩略切换器 + 继续观看 + 各库海报行
- 媒体库 / 搜索 / 详情 / 分季分集列表 / 立即播放
- 断点续播(位置钳制防坏数据)+ 播放进度上报 + 看完标记 + 看完自动下一集
- **备用线路**:详情页一键切换反代出口,播放链路(PlaybackInfo/媒体流/字幕/进度)整体切换,登录态通用
- 播放链路诊断面板:管线、直连状态、码率走势实时可见
- 快捷键:空格暂停、←/→ 快进退、F 全屏、↑/↓ 音量

## 播放链路

```
登录(AuthenticateByName,token 存 localStorage)
   ↓
PlaybackInfo(DeviceProfile 声明直连能力,服务器确认 SupportsDirectPlay)
   ↓
libmedia AVPlayer.load(stream.mkv?Static=true, FetchIO + Range)
   ├─ WebCodecs 硬解(首选)
   ├─ MSE(HDR/兼容场景)
   └─ WASM 软解(兜底,多线程)
   ↓
LOADED 事件 → 续播定位(超出片长自动回 0)→ play
   ↓
外挂字幕:Emby 提取接口 → ASS 归一化(固定格式)→ loadExternalSubtitle
   ↓
进度上报:起播 + 每 10 秒 + Stopped(位置钳制防历史坏数据)
```

## 目录结构

```
├── index.html                 # 入口(标题/favicon)
├── src/
│   ├── config.ts              # ★ 站点配置:站名 / 注册页 / 备用线路
│   ├── api/
│   │   ├── emby.ts            # EmbyApi:登录/PlaybackInfo/进度/字幕提取/withServer 线路克隆
│   │   └── types.ts           # Emby 接口类型
│   ├── player/
│   │   ├── session.ts         # 播放会话(含备用线路地址,sessionStorage 6h 过期)
│   │   ├── deviceProfile.ts   # 直连能力声明 + 音轨优选 + AAC 本地解码判定
│   │   ├── subtitles.ts       # 字幕提取多 URL 兜底 + ASS 归一化 + 双语处理
│   │   ├── fonts.ts           # 字体清单/注册(libass 与 CSS 双格式)
│   │   └── jassubHost.ts      # JASSUB 宿主(回退通道)
│   ├── pages/
│   │   ├── Login.tsx          # 登录(用户名/密码,注册外链)
│   │   ├── Home.tsx           # 首页(Hero 随机推荐 / 继续观看 / 库行)
│   │   ├── Library.tsx        # 媒体库浏览/搜索
│   │   ├── Detail.tsx         # 详情(直接开播 + 备用线路按钮)
│   │   └── PlayerLite.tsx     # ★ 播放页(libmedia 集成/看门狗/诊断面板/控制栏)
│   └── components/            # Header / PosterCard
├── public/
│   ├── wasm/                  # 自托管 libmedia 解码器(13 编解码器 × 4 变体)
│   └── fonts/                 # 思源黑体子集(woff2 + ttf 双格式,原因见下)
├── build-deploy.sh            # 构建并部署到 Nginx/OpenResty 站点目录
└── vite.config.ts             # base=/stream/,avplayer 分块与 wasm 拷贝
```

## 快速开始

```bash
npm install
npm run dev          # 开发(需在 src/config.ts 或登录后使用你的 Emby 地址)
npm run build        # 产物 dist/,base=/stream/
./build-deploy.sh    # 构建并部署(SITE 环境变量指定目标目录)
```

首次使用:部署后访问 `https://你的域名/stream/`,登录你的 Emby 账号即可。

## 配置项(src/config.ts)

| 配置 | 说明 |
|---|---|
| `APP_NAME` | 站点名(浏览器标签) |
| `REGISTER_URL` | 注册页外链 |
| `MIRROR_SERVER` | 备用反代线路完整地址;留空隐藏"备用线路"入口 |

## 部署要点

### 1. COOP/COEP(多线程软解必需)

播放器路径的响应头必须带:

```nginx
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Embedder-Policy credentialless always;
```

### 2. 静态资源缓存(推荐)

```nginx
# vite 内容哈希产物:一年不可变
location ~* "^/stream/assets/.+-[0-9A-Za-z_-]{8}\.(js|css)$" {
    root /var/www;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
# 入口 HTML:永远协商,发版立即生效
location = /stream/index.html {
    add_header Cache-Control "no-cache";
    # COOP/COEP 同样要带
}
# wasm/字体:1 天
location /stream/ {
    add_header Cache-Control "public, max-age=86400";
    # COOP/COEP 同样要带
}
```

反代 Emby API 时**不要**覆盖 `Cache-Control`——Emby 对海报自带
`public, max-age=86400`,覆盖成 no-cache 会让全站图片失去缓存。

### 3. 备用反代线路(Caddy 示例)

```caddy
emby1.example.com {
    reverse_proxy https://源站IP:443 {
        transport http {
            tls_server_name emby.example.com   # 回源 SNI
        }
        header_up Host emby.example.com        # 回源 Host
        flush_interval -1                      # 视频流边收边发
        tls_insecure_skip_verify               # 源站用 CF Origin 证书时需要
    }
}
```

## 隐私与安全

- 仓库不含任何凭据/服务器 IP/内网信息;登录 token 只存浏览器 localStorage
- 内部文档、测试脚本(含会话注入的验证脚本)均在 `.gitignore` 中,不入库
- 自部署时请把 `src/config.ts` 的注册页与备用线路改成你自己的地址

## 已知限制

- TrueHD 音轨无 wasm 解码器,遇到时会请求服务器做音频转码(视频仍直连)
- 杜比视界 Profile 5 无解(会色彩异常);Profile 8 按 HDR10/SDR 播
- 启用了二步验证的 Emby 账号无法登录(登录页未提供动态码输入)
- 网页端不发起任何转码:硬解不可用且 WASM 也带不动的极高码率片源只能靠多线程软解

## 致谢

- [libmedia](https://github.com/zhaohappy/libmedia)(LGPL-3.0)——播放内核
- [JASSUB](https://github.com/YouTube-Extension/JASSUB)——libass wasm 字幕渲染(回退通道)
- [思源黑体](https://github.com/adobe-fonts/source-han-sans)(OFL)——字幕字体
- [TMDB](https://www.themoviedb.org/)——影片元数据(由 Emby 服务端获取)

## 许可

本项目代码以 MIT 许可发布(见 LICENSE);依赖的 libmedia 为 LGPL-3.0,
未引入 x264/x265 等 GPL 编码器组件。
