/**
 * haptics.js - 全局触感反馈震动引擎
 * 针对微信 iOS/Android 提供分级物理触感回馈与防抖节流
 */

var lastHapticTime = 0;
var HAPTIC_THROTTLE_MS = 60; // 60ms 防抖门禁，防止高频滑动时震动马达过载

function canVibrate() {
  return typeof wx !== 'undefined' && typeof wx.vibrateShort === 'function';
}

function triggerVibration(type) {
  if (!canVibrate()) return;
  var now = Date.now();
  if (now - lastHapticTime < HAPTIC_THROTTLE_MS) return;
  lastHapticTime = now;
  try {
    wx.vibrateShort({ type: type || 'light' });
  } catch (e) {
    // 静默降级
  }
}

/**
 * 轻微触感 (Light Impact)：
 * 用于滑动条刻度吸附、微调按钮步进、播放/暂停切换
 */
function impactLight() {
  triggerVibration('light');
}

/**
 * 中度触感 (Medium Impact)：
 * 用于磁吸对齐、片段贴合、拖拽落位、删除选区
 */
function impactMedium() {
  triggerVibration('medium');
}

/**
 * 坚实重感 (Heavy Impact)：
 * 用于激光剃刀切断、分割音频落刀等关键物理动作
 */
function impactHeavy() {
  triggerVibration('heavy');
}

/**
 * 成功微脉冲 (Notification Success)：
 * 两次轻微轻触脉冲 (间隔 70ms)，用于提取成功、入库成功、导出就绪
 */
function notificationSuccess() {
  if (!canVibrate()) return;
  triggerVibration('light');
  setTimeout(function() {
    try {
      if (typeof wx !== 'undefined' && wx.vibrateShort) {
        wx.vibrateShort({ type: 'light' });
      }
    } catch (e) {}
  }, 70);
}

module.exports = {
  impactLight: impactLight,
  impactMedium: impactMedium,
  impactHeavy: impactHeavy,
  notificationSuccess: notificationSuccess,
};
