/**
 * 站点配置:部署自己的实例时修改这里
 */

/** 站点名(浏览器标签标题,见 index.html <title>) */
export const APP_NAME = '动漫一生推'

/** 注册页地址 */
export const REGISTER_URL = 'https://yh.heimao.dpdns.org/'

/**
 * 备用反代线路:同一台 Emby 的另一条出口(反代到源站 IP 时注意
 * 配 tls_server_name + Host 头;若源站使用 CF Origin 证书需跳过校验)。
 * 留空则隐藏详情页的"备用线路"入口。
 */
export const MIRROR_SERVER = 'https://emby1.heimao.dpdns.org'
