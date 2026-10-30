/**
 * 单色矢量图标库 (Monochrome Vector SVG Data URIs)
 * 专为高保真专业音频工作站 (DAW / NLE) 设计
 * 纯单色渲染：深炭黑 #1C1917 / 纯白 #FFFFFF / 警示单色红 #DC2626 / 品牌橙 #EA580C
 */

'use strict';

function makeUri(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.trim());
}

var C_DARK = '#1C1917';
var C_WHITE = '#FFFFFF';
var C_RED = '#DC2626';
var C_MUTED = '#78716C';
var C_ORANGE = '#EA580C';

var ICONS = {
  // 剪刀 / 光标剪开 (主色/白/炭黑)
  split: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>'),
  splitWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_WHITE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>'),
  scissors: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>'),

  // 变速 (速度表指针)
  speed: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14l3-3"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>'),

  // 音量 (扬声器声波)
  volume: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'),

  // 淡入淡出 (平滑过渡坡度)
  fade: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M3 20C8 20 12 5 21 4"/></svg>'),

  // 智能降噪 (声波斜杠过滤)
  denoise: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2-5 4 10 4-10 2 5h5"/><line x1="4" y1="4" x2="20" y2="20"/></svg>'),

  // 声音 EQ / 均衡器
  eq: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="4" cy="12" r="2" fill="' + C_DARK + '"/><circle cx="12" cy="10" r="2" fill="' + C_DARK + '"/><circle cx="20" cy="14" r="2" fill="' + C_DARK + '"/></svg>'),

  // 磁吸 / 对齐光标 (马蹄磁铁)
  magnet: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 12 0V3"/><path d="M6 7H3"/><path d="M21 7h-3"/><path d="M6 3H3v4h3V3z"/><path d="M18 3h3v4h-3V3z"/></svg>'),
  magnetActive: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_ORANGE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 12 0V3"/><path d="M6 7H3"/><path d="M21 7h-3"/><path d="M6 3H3v4h3V3z"/><path d="M18 3h3v4h-3V3z"/></svg>'),

  // 换音轨 (上下互换双箭头)
  track: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><polyline points="16 3 20 7 16 11"/><line x1="20" y1="17" x2="4" y2="17"/><polyline points="8 13 4 17 8 21"/></svg>'),

  // 裁至选区 (裁剪标框)
  crop: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>'),

  // 复制片段 (双层卡片)
  copy: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'),
  copyWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_WHITE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'),

  // 粘贴片段 (板夹图纸)
  paste: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>'),
  pasteWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_WHITE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>'),

  // 压缩 / 文件体积控制
  compress: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'),
  compressWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_WHITE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'),

  // 前移 (向左微步箭头)
  prev: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><line x1="19" y1="12" x2="9" y2="12"/></svg>'),

  // 后移 (向右微步箭头)
  next: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><line x1="5" y1="12" x2="15" y2="12"/></svg>'),

  // 删除 (单色红垃圾桶)
  trash: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_RED + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>'),

  // 播放
  play: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + C_DARK + '" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>'),
  playWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + C_WHITE + '" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>'),

  // 暂停
  pause: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + C_DARK + '" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'),
  pauseWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="' + C_WHITE + '" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'),

  // 耳机 / 监听 / 试听
  headphone: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>'),

  // 调音台 / 控制台
  mixer: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'),

  // 光标指针 (选择模式)
  cursor: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 18 3-7 7-3L3 3z"/></svg>'),
  cursorActive: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_ORANGE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 18 3-7 7-3L3 3z"/></svg>'),
  cursorWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_WHITE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 18 3-7 7-3L3 3z"/></svg>'),

  // 时间轴缩放 (放大镜)
  zoom: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'),

  // 归零开头 (跳回起点)
  zero: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>'),

  // 撤销
  undo: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>'),

  // 全选选区 (边框框选)
  selectAll: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>'),

  // 加号 (新建音轨)
  plus: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_DARK + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'),
  plusWhite: makeUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + C_WHITE + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>')
};

module.exports = ICONS;
