把字幕用的字体文件(otf / ttf / woff2)放到本目录,然后在 fonts.json 里登记,例如:

{
  "fallback": "思源黑体",
  "fonts": [
    { "family": "思源黑体", "url": "/fonts/SourceHanSansCN-Regular.otf", "default": true },
    { "family": "霞鹜文楷", "url": "/fonts/LXGWWenKai-Regular.ttf" }
  ]
}

说明:
- family 必须和 ASS 字幕里 Style 行引用的字体名一致,libass 才能匹配上;
- 一个字体文件如果内含多个字族名,可以多写几条 family 指向同一个文件;
- fallback 是缺字体时的兜底字体;
- Chrome 上播放器还会自动读取本机已安装字体来补缺(Local Font Access,首次会弹授权)。
