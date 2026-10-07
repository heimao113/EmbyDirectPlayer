/**
 * 字体加载策略(三路兜底):
 * 1. 应用 public/fonts/ 目录下的 fonts.json 清单(用户自己放字体文件)
 * 2. Chrome 的 Local Font Access API 读本机字体(JASSUB 的 useLocalFonts)
 * 3. 都没有时 libass 用内置默认字形渲染(CJK 可能缺字,提示用户配置字体)
 */

export interface FontEntry {
  family: string
  url: string
  default?: boolean
}

export interface FontManifest {
  fallback?: string
  fonts: FontEntry[]
}

// base='' 或 '/player/',fonts.json 里的绝对路径(/fonts/..)要挂到部署子路径下
const BASE_URL = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : import.meta.env.BASE_URL + '/'
const resolveUrl = (u: string) => (u.startsWith('/') ? BASE_URL.replace(/\/$/, '') + u : u)

export async function loadFontManifest(): Promise<FontManifest> {
  try {
    const res = await fetch(`${BASE_URL}fonts/fonts.json`)
    if (!res.ok) return { fonts: [] }
    const data = await res.json()
    const fonts: FontEntry[] = Array.isArray(data?.fonts) ? data.fonts : []
    return { fallback: data?.fallback, fonts: fonts.filter((f) => f.family && f.url) }
  } catch {
    return { fonts: [] }
  }
}

/**
 * 转成 JASSUB 需要的 availableFonts 映射与默认字体名(同一文件多别名只加载一次)。
 * 注意:JASSUB 内嵌的 freetype 读不了 woff2(静默零字形→字幕整条不显示),
 * 必须喂 TTF/OTF——manifest 里的 .woff2 一律换成同名的 .ttf(public/fonts 同时提供两种格式)。
 */
export function toJassubFontConfig(manifest: FontManifest) {
  const availableFonts: Record<string, string> = {}
  const loaded = new Set<string>()
  const fontUrls: string[] = []
  let fallback = manifest.fallback
  let fallbackTtf = ''
  for (const f of manifest.fonts) {
    const url = resolveUrl(f.url)
    const ttfUrl = url.endsWith('.woff2') ? url.slice(0, -'.woff2'.length) + '.ttf' : url
    availableFonts[f.family] = ttfUrl
    if (!loaded.has(ttfUrl)) {
      loaded.add(ttfUrl)
      fontUrls.push(ttfUrl)
    }
    if (!fallback || f.default) fallback = f.family
    if ((!fallbackTtf || f.default) && ttfUrl) fallbackTtf = ttfUrl
  }
  // libass 的通用兜底名也要有落点,否则 Style 字体名全部 miss 时一条都画不出
  if (fallbackTtf) availableFonts['sans-serif'] = fallbackTtf
  return { availableFonts, fontUrls, fallback }
}

/** 字体 URL 去重注册 */
const registered = new Set<string>()

/**
 * 把 fonts.json 里的字体注册为 document FontFace(libmedia 的 DOM 字幕渲染
 * 走 CSS 字体匹配,注册后 ASS 里的字体名才能命中)。幂等,可重复调用。
 */
export async function registerFontFaces(): Promise<void> {
  const manifest = await loadFontManifest()
  await Promise.all(
    manifest.fonts.map(
      (f) =>
        new Promise<void>((resolve) => {
          const url = resolveUrl(f.url)
          if (registered.has(url)) return resolve()
          try {
            const face = new FontFace(f.family, `url(${url})`, { display: 'swap' })
            face
              .load()
              .then((loaded) => {
                document.fonts.add(loaded)
                registered.add(url)
                resolve()
              })
              .catch(() => resolve())
          } catch {
            resolve()
          }
        }),
    ),
  )
}
