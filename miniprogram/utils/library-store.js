/**
 * 作品库存储层 v1（docs/NEXT_UPDATE_PLAN.md §5.2 FR-31）
 *
 * 设计原则：
 * 1) 纯函数优先：normalize / add / remove / sort / stats / merge 等全部不依赖 wx，
 *    可以在 Node 里直接 require 做单测；
 * 2) 薄 IO 层：loadLibrary / saveLibrary / loadAndMigrate / clearLibrary 只在调用时
 *    探测 `typeof wx`，无 wx（Node / 单测）时安全降级为空表，不抛错；
 * 3) 数据契约（新键 audio_library_v1）：
 *      { version: 1, items: [item], notes?: { migratedFrom?, migratedAt?, clearedAt? } }
 *    item = {
 *      id,                 // 唯一字符串，展示列表 wx:key 用
 *      kind,               // 'convert' | 'edit'
 *      name,               // 结果文件名（展示名）
 *      sourceName,         // 转换输入名 / 剪辑首源名，可空
 *      format,             // 小写扩展名，如 'mp3'
 *      size,               // 字节数，未知为 0
 *      sizeText,           // 展示文本，如 '1.18 MB'
 *      durationText,       // 展示文本，如 '03:45'，可空
 *      fileID,             // 云文件 fileID（分享 / 下载）
 *      downloadUrl,        // 临时下载外链，可空
 *      createdAt,          // 毫秒时间戳
 *      expiresAt,          // createdAt + 24h（云端清理口径）
 *      extra: { targetFormat?, clipCount? }
 *    }
 * 4) 容量与过期：MAX_ITEMS=50，同 fileID 去重置顶，超限淘汰最旧；TTL=24h。
 * 5) 迁移：新键不存在时把旧键 audio_convert_history 逐条映射为 kind:'convert'
 *    写入新键；旧键只读、保留不删（降级兼容）。迁移只在"新键缺失"时发生，
 *    因此清空作品库不会复活已删除记录。
 */

'use strict';

var LIBRARY_KEY = 'audio_library_v1';
var LEGACY_KEY = 'audio_convert_history';
var VERSION = 1;
var MAX_ITEMS = 50;
var TTL_MS = 24 * 60 * 60 * 1000;
var KINDS = ['convert', 'edit'];
var SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/* ========================================================================== */
/* 基础小工具（不依赖 wx）                                                     */
/* ========================================================================== */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function toNumber(value, fallback) {
  if (typeof value === 'string' && value.trim() === '') return fallback;
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function toTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 统一时间基准：传入合法毫秒时间戳则用之，否则用当前时间。 */
function resolveNow(now) {
  var n = toNumber(now, 0);
  return n > 0 ? Math.floor(n) : Date.now();
}

/** 取文件名扩展名（小写，不含点）；无扩展名返回 ''。 */
function getExt(name) {
  var s = toTrimmedString(name);
  var m = /\.([A-Za-z0-9]{2,8})$/.exec(s);
  return m ? m[1].toLowerCase() : '';
}

function normalizeFormat(value, name) {
  var f = toTrimmedString(value).toLowerCase().replace(/^\./, '');
  if (f) return f;
  return getExt(name);
}

/** 短哈希：用于缺 id 时生成稳定 id（同一 createdAt + seed 结果一致，保证迁移幂等）。 */
function shortHash(str) {
  var s = String(str === undefined || str === null ? '' : str);
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return ('000000' + (h >>> 0).toString(36)).slice(-6);
}

function makeId(createdAt, seed) {
  return 'lib_' + Math.floor(createdAt) + '_' + shortHash(seed);
}

function asArray(list) {
  return Array.isArray(list) ? list : [];
}

/* ========================================================================== */
/* 展示格式化                                                                 */
/* ========================================================================== */

/** 字节数 → '0 B' / '1.18 MB'（与 editor-utils / index.js 现有口径一致）。 */
function formatBytes(bytes) {
  var b = toNumber(bytes, 0);
  if (!b || b <= 0) return '0 B';
  var k = 1024;
  var i = Math.floor(Math.log(b) / Math.log(k));
  if (i < 0) i = 0;
  if (i > SIZE_UNITS.length - 1) i = SIZE_UNITS.length - 1;
  return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + SIZE_UNITS[i];
}

/** 秒数 → 'mm:ss'（≥1 小时为 'h:mm:ss'）；非法/负数返回 ''。 */
function formatDurationText(seconds) {
  var total = toNumber(seconds, NaN);
  if (!isFinite(total) || total < 0) return '';
  total = Math.floor(total + 1e-6);
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
  return pad2(m) + ':' + pad2(s);
}

/* ========================================================================== */
/* 纯函数：normalize                                                          */
/* ========================================================================== */

/**
 * 把任意来源数据收敛成合法 item；无法还原出任何身份信息（name/fileID/downloadUrl
 * 全空）时返回 null。
 * @param {Object} raw
 * @param {number} [now] 缺时间字段时的回退时间戳（便于测试可复现）
 */
function normalizeItem(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  var kind = raw.kind === 'edit' ? 'edit' : 'convert';
  var name = toTrimmedString(raw.name) || toTrimmedString(raw.targetFileName) || toTrimmedString(raw.fileName);
  var fileID = toTrimmedString(raw.fileID);
  var downloadUrl = toTrimmedString(raw.downloadUrl) || toTrimmedString(raw.url);
  if (!name && !fileID && !downloadUrl) return null;

  var createdAt = toNumber(raw.createdAt, 0);
  if (!createdAt || createdAt <= 0) createdAt = resolveNow(now);

  var format = normalizeFormat(raw.format, name);
  if (!format && kind === 'edit') format = 'mp3';
  if (!name) name = (kind === 'edit' ? '剪辑作品' : '转换结果') + (format ? '.' + format : '');

  var size = toNumber(raw.size, 0);
  if (!isFinite(size) || size < 0) size = 0;

  var sizeText = toTrimmedString(raw.sizeText);
  if (!sizeText && size > 0) sizeText = formatBytes(size);

  var durationText = toTrimmedString(raw.durationText);
  if (!durationText) durationText = formatDurationText(raw.duration);

  var expiresAt = toNumber(raw.expiresAt, 0);
  if (!expiresAt || expiresAt <= 0) expiresAt = createdAt + TTL_MS;

  var rawExtra = raw.extra && typeof raw.extra === 'object' ? raw.extra : {};
  var extra = {};
  var targetFormat = toTrimmedString(rawExtra.targetFormat || raw.targetFormat).toUpperCase();
  if (targetFormat) extra.targetFormat = targetFormat;
  var clipCount = toNumber(
    rawExtra.clipCount !== undefined && rawExtra.clipCount !== null ? rawExtra.clipCount : raw.clipCount,
    0
  );
  if (clipCount > 0) extra.clipCount = Math.floor(clipCount);

  var id = toTrimmedString(raw.id);
  if (!id) id = makeId(createdAt, fileID || downloadUrl || name);

  return {
    id: id,
    kind: kind,
    name: name,
    sourceName: toTrimmedString(raw.sourceName) || toTrimmedString(raw.sourceFileName) || '',
    format: format || 'mp3',
    size: size,
    sizeText: sizeText,
    durationText: durationText,
    fileID: fileID,
    downloadUrl: downloadUrl,
    createdAt: createdAt,
    expiresAt: expiresAt,
    extra: extra,
  };
}

/** 排序（createdAt 新→旧，同时间按 id 倒序），不修改入参。 */
function sortItems(list) {
  var arr = asArray(list).filter(function (item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  });
  arr = arr.slice();
  arr.sort(function (a, b) {
    var ta = toNumber(a.createdAt, 0);
    var tb = toNumber(b.createdAt, 0);
    if (tb !== ta) return tb - ta;
    var ia = String(a.id || '');
    var ib = String(b.id || '');
    if (ia === ib) return 0;
    return ib > ia ? 1 : -1;
  });
  return arr;
}

/** 去重：优先按 fileID，其次按 id，保留排序后的首个（即最新）。 */
function dedupeItems(list) {
  var seenFile = {};
  var seenId = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item) continue;
    var fileID = toTrimmedString(item.fileID);
    var id = String(item.id || '');
    if (fileID) {
      if (seenFile[fileID]) continue;
      seenFile[fileID] = true;
    } else {
      if (id && seenId[id]) continue;
      if (id) seenId[id] = true;
    }
    out.push(item);
  }
  return out;
}

/** 任意列表 → 合法、去重、倒序的 item 数组。 */
function normalizeList(list) {
  var mapped = [];
  var arr = asArray(list);
  for (var i = 0; i < arr.length; i++) {
    var item = normalizeItem(arr[i]);
    if (item) mapped.push(item);
  }
  return dedupeItems(sortItems(mapped));
}

/* ========================================================================== */
/* 纯函数：写入来源（转换历史 / 剪辑导出）                                     */
/* ========================================================================== */

/**
 * 旧转换历史记录 → item。
 * 兼容 record 字段：{ id, fileName, targetFileName, sourceExt, targetFormat,
 * targetSize, targetSizeText, fileID, downloadUrl, time, duration }。
 * 旧记录 id 是 Date.now() 毫秒数，可用作 createdAt 的回退来源，保证迁移幂等。
 */
function itemFromConvert(record, now) {
  if (!record || typeof record !== 'object') return null;
  var ts = resolveNow(now);

  var createdAt = toNumber(record.createdAt, 0);
  if (!createdAt || createdAt <= 0) {
    var legacyId = toNumber(record.id, 0);
    if (legacyId > 1e12 && legacyId < 1e15) createdAt = Math.floor(legacyId); // Date.now() 量级
  }
  if (!createdAt || createdAt <= 0) createdAt = ts;

  var sourceName = toTrimmedString(record.fileName) || toTrimmedString(record.sourceName);
  var format = normalizeFormat(record.targetFormat, record.targetFileName);

  var name = toTrimmedString(record.targetFileName) || toTrimmedString(record.name);
  if (!name) {
    var base = sourceName.replace(/\.[^.]+$/, '');
    name = (base || '转换结果') + (format ? '.' + format : '');
  }

  var size = toNumber(record.targetSize, 0);
  if (!isFinite(size) || size < 0) size = 0;

  return normalizeItem(
    {
      kind: 'convert',
      name: name,
      sourceName: sourceName,
      format: format,
      size: size,
      sizeText: toTrimmedString(record.targetSizeText),
      durationText: toTrimmedString(record.durationText) || formatDurationText(record.duration),
      fileID: record.fileID,
      downloadUrl: record.downloadUrl,
      createdAt: createdAt,
      extra: {
        targetFormat: toTrimmedString(record.targetFormat).toUpperCase() || (format ? format.toUpperCase() : ''),
      },
    },
    createdAt
  );
}

/**
 * 剪辑导出结果 → item。
 * @param {Object} data { fileName, size, sizeText, durationText, fileID, downloadUrl?, clipCount, sourceName? }
 */
function itemFromEdit(data, now) {
  if (!data || typeof data !== 'object') return null;
  var ts = resolveNow(now);

  var createdAt = toNumber(data.createdAt, 0);
  if (!createdAt || createdAt <= 0) createdAt = ts;

  var name = toTrimmedString(data.fileName) || toTrimmedString(data.name);
  var format = normalizeFormat(data.format, name) || 'mp3';

  var sourceName = toTrimmedString(data.sourceName) || toTrimmedString(data.sourceFileName);
  if (!sourceName && Array.isArray(data.sourceNames) && data.sourceNames.length) {
    sourceName = toTrimmedString(data.sourceNames[0]);
  }

  var size = toNumber(data.size, 0);
  if (!isFinite(size) || size < 0) size = 0;

  var clipCount = toNumber(data.clipCount, 0);
  var targetFormat = toTrimmedString(data.targetFormat).toUpperCase();

  return normalizeItem(
    {
      kind: 'edit',
      name: name,
      sourceName: sourceName,
      format: format,
      size: size,
      sizeText: toTrimmedString(data.sizeText),
      durationText: toTrimmedString(data.durationText) || formatDurationText(data.duration),
      fileID: data.fileID,
      downloadUrl: data.downloadUrl,
      createdAt: createdAt,
      extra: {
        targetFormat: targetFormat,
        clipCount: clipCount > 0 ? Math.floor(clipCount) : 0,
      },
    },
    createdAt
  );
}

/* ========================================================================== */
/* 纯函数：增删 / 过期 / 统计 / 旧数据合并                                     */
/* ========================================================================== */

/**
 * 入库：同 fileID（或同 id）去重并置顶，按时间倒序，超出 max 淘汰最旧。
 * 不修改入参。
 * @param {Array} list 现有 item 列表
 * @param {Object} item 待入库 item（可为原始数据，内部会 normalize）
 * @param {{max?: number}} [options]
 * @returns {Array} 新列表
 */
function addItem(list, item, options) {
  var opts = options || {};
  var max = toNumber(opts.max, MAX_ITEMS);
  if (!isFinite(max) || max <= 0) max = MAX_ITEMS;

  var current = normalizeList(list);
  var incoming = normalizeItem(item);
  if (!incoming) return current;

  var out = [];
  for (var i = 0; i < current.length; i++) {
    var cur = current[i];
    var sameFile = incoming.fileID && cur.fileID && cur.fileID === incoming.fileID;
    var sameId = String(cur.id) === String(incoming.id);
    if (sameFile || sameId) continue;
    out.push(cur);
  }
  out.push(incoming);
  return sortItems(out).slice(0, max);
}

/** 删除指定 id；返回新列表（不修改入参）。 */
function removeItem(list, id) {
  var target = toTrimmedString(id);
  var current = normalizeList(list);
  if (!target) return current;
  var out = [];
  for (var i = 0; i < current.length; i++) {
    if (String(current[i].id) !== target) out.push(current[i]);
  }
  return out;
}

/** 是否已过期：now > expiresAt（缺 expiresAt 时回退 createdAt + TTL）。 */
function isExpired(item, now) {
  if (!item || typeof item !== 'object') return false;
  var ts = resolveNow(now);
  var expiresAt = toNumber(item.expiresAt, 0);
  if (!expiresAt || expiresAt <= 0) {
    var createdAt = toNumber(item.createdAt, 0);
    if (!createdAt || createdAt <= 0) return false;
    expiresAt = createdAt + TTL_MS;
  }
  return ts > expiresAt;
}

/** 统计：{ total, convert, edit, expired }。 */
function stats(list, now) {
  var arr = asArray(list);
  var result = { total: 0, convert: 0, edit: 0, expired: 0 };
  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    result.total += 1;
    if (item.kind === 'edit') result.edit += 1;
    else result.convert += 1;
    if (isExpired(item, now)) result.expired += 1;
  }
  return result;
}

/**
 * 旧键 audio_convert_history 的记录合并为作品库 item 列表。
 * 幂等：已规范化的 item（含 kind 字段）会直接 normalize 透传，同 fileID/id 去重，
 * 因而 mergeLegacy(mergeLegacy(x)) 与 mergeLegacy(x) 结果一致。
 */
function mergeLegacy(legacyList, now) {
  var ts = resolveNow(now);
  var arr = asArray(legacyList);
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var raw = arr[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    var item = raw.kind === 'convert' || raw.kind === 'edit' ? normalizeItem(raw, ts) : itemFromConvert(raw, ts);
    if (!item) continue;
    out = addItem(out, item, { max: MAX_ITEMS });
  }
  return out;
}

/* ========================================================================== */
/* 薄 IO 层（wx.getStorageSync / setStorageSync；无 wx 安全降级）               */
/* ========================================================================== */

function getStorageApi() {
  try {
    if (typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function') return wx;
  } catch (e) {}
  return null;
}

function readRaw(key) {
  var api = getStorageApi();
  if (!api) return undefined;
  try {
    return api.getStorageSync(key);
  } catch (e) {
    return undefined;
  }
}

function writeRaw(key, value) {
  var api = getStorageApi();
  if (!api || typeof api.setStorageSync !== 'function') return false;
  try {
    api.setStorageSync(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

/** 新键内容是否已存在（对象 {items:[]} 或直接数组都视为存在）。 */
function hasLibraryPayload(raw) {
  if (!raw) return false;
  if (Array.isArray(raw)) return true;
  return typeof raw === 'object' && Array.isArray(raw.items);
}

function extractItems(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return normalizeList(raw);
  if (typeof raw === 'object' && Array.isArray(raw.items)) return normalizeList(raw.items);
  return null;
}

function extractNotes(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.notes && typeof raw.notes === 'object') {
    return raw.notes;
  }
  return null;
}

/** 读取作品库 items；无 wx / 无数据 / 解析失败均返回 []。 */
function loadLibrary() {
  var items = extractItems(readRaw(LIBRARY_KEY));
  return items || [];
}

/**
 * 保存作品库（自动 normalize + 排序 + 去重 + 50 条上限）。
 * 新键写入 { version:1, items }；可传入 notes 附加迁移/清空标记。
 * 返回最终落库（或降级时计算出的）items 数组，不抛错。
 */
function saveLibrary(list, notes) {
  var items = normalizeList(list).slice(0, MAX_ITEMS);
  var payload = { version: VERSION, items: items };
  var noteValue = notes && typeof notes === 'object' ? notes : extractNotes(readRaw(LIBRARY_KEY));
  if (noteValue) payload.notes = noteValue;
  writeRaw(LIBRARY_KEY, payload);
  return items;
}

/**
 * 读取作品库并在"新键缺失"时执行一次性旧数据迁移。
 * 返回库对象 { version, items, notes? }（index.js 角标读取 lib.items）。
 * 迁移策略：旧键 audio_convert_history 只读，映射后写入新键，旧键保留不删。
 */
function loadAndMigrate() {
  var raw = readRaw(LIBRARY_KEY);
  if (hasLibraryPayload(raw)) {
    return { version: VERSION, items: extractItems(raw) || [], notes: extractNotes(raw) || undefined };
  }

  var ts = Date.now();
  var legacy = readRaw(LEGACY_KEY);
  var legacyItems = mergeLegacy(Array.isArray(legacy) ? legacy : [], ts);
  if (!legacyItems.length) {
    return { version: VERSION, items: [] };
  }

  var notes = { migratedFrom: LEGACY_KEY, migratedAt: ts };
  var saved = saveLibrary(legacyItems, notes);
  return { version: VERSION, items: saved, notes: notes };
}

/**
 * 清空作品库：写入空结构而不是删除新键。
 * 关键：新键存在（即便为空）后，loadAndMigrate 不会再迁移旧键，避免已删除记录复活。
 */
function clearLibrary() {
  writeRaw(LIBRARY_KEY, { version: VERSION, items: [], notes: { clearedAt: Date.now() } });
  return [];
}

/** loadAndMigrate → addItem → saveLibrary，返回最终 items 数组。 */
function addToLibrary(item) {
  var library = loadAndMigrate();
  var next = addItem(library.items, item, { max: MAX_ITEMS });
  return saveLibrary(next);
}

/** loadAndMigrate → removeItem → saveLibrary，返回最终 items 数组。 */
function removeFromLibrary(id) {
  var library = loadAndMigrate();
  var next = removeItem(library.items, id);
  return saveLibrary(next);
}

module.exports = {
  LIBRARY_KEY: LIBRARY_KEY,
  LEGACY_KEY: LEGACY_KEY,
  VERSION: VERSION,
  MAX_ITEMS: MAX_ITEMS,
  TTL_MS: TTL_MS,
  KINDS: KINDS,

  normalizeItem: normalizeItem,
  normalizeList: normalizeList,
  itemFromConvert: itemFromConvert,
  itemFromEdit: itemFromEdit,
  addItem: addItem,
  removeItem: removeItem,
  sortItems: sortItems,
  dedupeItems: dedupeItems,
  isExpired: isExpired,
  stats: stats,
  mergeLegacy: mergeLegacy,

  formatBytes: formatBytes,
  formatDurationText: formatDurationText,
  makeId: makeId,

  loadLibrary: loadLibrary,
  saveLibrary: saveLibrary,
  loadAndMigrate: loadAndMigrate,
  clearLibrary: clearLibrary,
  addToLibrary: addToLibrary,
  removeFromLibrary: removeFromLibrary,
};
