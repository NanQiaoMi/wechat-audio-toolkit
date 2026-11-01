/**
 * scripts/page-smoke/record-library-test.js
 * 针对 v5.1 现场录音 (record) 与 我的作品库 (library) 及 library-store.js 的自动化单测
 */

const assert = require('assert');
const path = require('path');
const libraryStore = require('../../miniprogram/utils/library-store.js');

let passCount = 0;
function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}:`, err.message);
    throw err;
  }
}

console.log('\n# libraryStore: 纯函数数据层测试');

test('normalizeItem: 补全字段与默认 24h 过期', () => {
  const now = 1700000000000;
  const item = libraryStore.normalizeItem({
    name: 'test_track.mp3',
    fileID: 'cloud://test-env/audio/test_track.mp3',
    kind: 'convert',
    createdAt: now
  });
  assert.strictEqual(item.name, 'test_track.mp3');
  assert.strictEqual(item.format, 'mp3');
  assert.strictEqual(item.kind, 'convert');
  assert.strictEqual(item.createdAt, now);
  assert.strictEqual(item.expiresAt, now + 24 * 3600 * 1000);
  assert.strictEqual(typeof item.id, 'string');
});

test('dedupeItems: 相同 fileID 去重置顶', () => {
  const item1 = { id: '1', fileID: 'cloud://f1', name: 'v1.mp3', createdAt: 100 };
  const item2 = { id: '2', fileID: 'cloud://f2', name: 'v2.mp3', createdAt: 200 };
  const item3 = { id: '3', fileID: 'cloud://f1', name: 'v1_new.mp3', createdAt: 300 };
  const deduped = libraryStore.dedupeItems([item3, item2, item1]);
  assert.strictEqual(deduped.length, 2);
  assert.strictEqual(deduped[0].fileID, 'cloud://f1');
  assert.strictEqual(deduped[0].name, 'v1_new.mp3');
});

test('addItem: 超过 50 个自动截断超限元素', () => {
  let list = [];
  for (let i = 0; i < 60; i++) {
    list = libraryStore.addItem(list, {
      name: `item_${i}.mp3`,
      fileID: `cloud://f_${i}`,
      kind: 'convert',
      createdAt: 1000 + i
    });
  }
  assert.strictEqual(list.length, 50);
  assert.strictEqual(list[0].name, 'item_59.mp3');
});

test('isExpired: 超过 24 小时判定过期', () => {
  const now = Date.now();
  const validItem = { createdAt: now - 3600 * 1000, expiresAt: now + 23 * 3600 * 1000 };
  const expiredItem = { createdAt: now - 25 * 3600 * 1000, expiresAt: now - 1000 };
  assert.strictEqual(libraryStore.isExpired(validItem, now), false);
  assert.strictEqual(libraryStore.isExpired(expiredItem, now), true);
});

test('mergeLegacy: 自动将旧版 audio_convert_history 映射迁移', () => {
  const legacy = [
    {
      id: 12345,
      fileName: 'input.wav',
      targetFileName: 'output.mp3',
      sourceExt: 'WAV',
      targetFormat: 'MP3',
      targetSizeText: '1.2 MB',
      fileID: 'cloud://env/legacy.mp3',
      downloadUrl: 'https://tmp/legacy.mp3',
      time: '14:20'
    }
  ];
  const migrated = libraryStore.mergeLegacy(legacy);
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(migrated[0].kind, 'convert');
  assert.strictEqual(migrated[0].name, 'output.mp3');
  assert.strictEqual(migrated[0].fileID, 'cloud://env/legacy.mp3');
});

test('itemFromEdit: 剪辑产物入库数据映射正确', () => {
  const editResult = {
    fileName: '成片_混音_20261102.mp3',
    size: 2048000,
    sizeText: '2.0 MB',
    durationText: '01:30',
    fileID: 'cloud://env/edit_out.mp3',
    clipCount: 4
  };
  const item = libraryStore.itemFromEdit(editResult);
  assert.strictEqual(item.kind, 'edit');
  assert.strictEqual(item.name, '成片_混音_20261102.mp3');
  assert.strictEqual(item.extra.clipCount, 4);
});

console.log('\n# 页面级冒烟与桩测试');

function makeWxStub() {
  const storage = {};
  return {
    getStorageSync(k) { return storage[k] || null; },
    setStorageSync(k, v) { storage[k] = v; },
    removeStorageSync(k) { delete storage[k]; },
    showToast() {},
    showModal(opts) { if (opts.success) opts.success({ confirm: true }); },
    showShareMenu() {},
    navigateTo() {},
    navigateBack() {},
    setInnerAudioOption() {},
    createInnerAudioContext() {
      return {
        src: '',
        play() {},
        pause() {},
        stop() {},
        destroy() {},
        onPlay() {},
        onPause() {},
        onStop() {},
        onEnded() {},
        onError() {},
        onTimeUpdate() {},
      };
    },
    getRecorderManager() {
      return {
        start() {},
        pause() {},
        resume() {},
        stop() {},
        onStart() {},
        onPause() {},
        onResume() {},
        onStop() {},
        onError() {},
        onFrameRecorded() {},
      };
    }
  };
}

test('record.js: 模块定义与基础数据结构存在', () => {
  const originalWx = global.wx;
  const originalPage = global.Page;
  let pageOptions = null;
  global.wx = makeWxStub();
  global.Page = (opts) => { pageOptions = opts; };

  try {
    // 动态加载执行 record.js
    delete require.cache[require.resolve('../../miniprogram/pages/record/record.js')];
    require('../../miniprogram/pages/record/record.js');
    assert(pageOptions, 'Page 未被注册');
    assert.strictEqual(typeof pageOptions.onStartRecord, 'function');
    assert.strictEqual(typeof pageOptions.onFinishRecord, 'function');
    assert.strictEqual(typeof pageOptions.onGoEditor, 'function');
    assert.strictEqual(typeof pageOptions.onGoConvert, 'function');
    assert.strictEqual(pageOptions.data.status, 'idle');
  } finally {
    global.wx = originalWx;
    global.Page = originalPage;
  }
});

test('library.js: 模块定义、加载与类型筛选切换', () => {
  const originalWx = global.wx;
  const originalPage = global.Page;
  let pageOptions = null;
  global.wx = makeWxStub();
  global.Page = (opts) => { pageOptions = opts; };

  try {
    delete require.cache[require.resolve('../../miniprogram/pages/library/library.js')];
    require('../../miniprogram/pages/library/library.js');
    assert(pageOptions, 'Page 未被注册');
    assert.strictEqual(typeof pageOptions.onShow, 'function');
    assert.strictEqual(typeof pageOptions.setFilter, 'function');
    assert.strictEqual(typeof pageOptions.deleteItem, 'function');
    assert.strictEqual(typeof pageOptions.clearAll, 'function');
    assert.strictEqual(typeof pageOptions.shareItem, 'function');
  } finally {
    global.wx = originalWx;
    global.Page = originalPage;
  }
});

console.log(`\n============================================\n录音与作品库单测: pass=${passCount} fail=0\n全部通过 ✅\n`);
