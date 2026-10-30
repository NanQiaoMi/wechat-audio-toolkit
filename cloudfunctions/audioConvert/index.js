// cloudfunctions/audioConvert/index.js
// 微信云开发全格式音频转码服务 (FFmpeg)
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

/**
 * 获取可执行的 FFmpeg 路径
 */
function getFFmpegPath() {
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
      try {
        fs.chmodSync(ffmpegInstaller.path, 0o755);
      } catch (e) {
        console.warn('chmod ffmpeg warning:', e);
      }
      return ffmpegInstaller.path;
    }
  } catch (err) {
    console.warn('@ffmpeg-installer/ffmpeg load fail, trying fallback:', err);
  }

  // 备用系统路径
  const fallbacks = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

/**
 * 执行转码命令
 */
function runFFmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024, timeout: 50000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`FFmpeg转码失败: ${error.message} - ${stderr || ''}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * 从 FFmpeg 日志解析音频时长 (秒)
 */
function extractDuration(log) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if (match) {
    const hours = parseInt(match[1], 10);
    const mins = parseInt(match[2], 10);
    const secs = parseFloat(match[3]);
    return Math.round(hours * 3600 + mins * 60 + secs);
  }
  return 0;
}

exports.main = async (event, context) => {
  const startTime = Date.now();
  const {
    fileID,
    targetFormat = 'mp3',
    fileName = '',
    options = {},
    autoCleanSource = true,
  } = event;

  if (!fileID) {
    return {
      success: false,
      code: 'PARAM_ERROR',
      errorMessage: '缺少源音频 fileID 参数',
    };
  }

  // 参数规范化
  const format = targetFormat.toLowerCase().trim();
  const bitrate = options.bitrate || '192k'; // 320k, 192k, 128k
  const sampleRate = options.sampleRate; // 44100, 48000
  const channels = options.channels || 2; // 1, 2

  // 临时文件路径生成
  const randomSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const extMatch = (fileName || fileID).match(/\.([a-zA-Z0-9]+)(\?|$)/);
  const srcExt = extMatch ? extMatch[1].toLowerCase() : 'audio';

  const inputPath = path.join('/tmp', `in_${randomSuffix}.${srcExt}`);
  const outputPath = path.join('/tmp', `out_${randomSuffix}.${format}`);

  try {
    console.log(`[audioConvert] 开始下载源音频: ${fileID}`);
    const downloadRes = await cloud.downloadFile({ fileID });
    fs.writeFileSync(inputPath, downloadRes.fileContent);

    const inputStats = fs.statSync(inputPath);
    console.log(`[audioConvert] 源音频下载完成, 大小: ${(inputStats.size / 1024).toFixed(1)} KB`);

    // 构建转码参数
    const ffmpegPath = getFFmpegPath();
    const args = ['-y', '-i', inputPath];

    // 格式对应编码器与参数配置
    switch (format) {
      case 'mp3':
        args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
        break;
      case 'wav':
        args.push('-c:a', 'pcm_s16le');
        break;
      case 'm4a':
      case 'aac':
        args.push('-c:a', 'aac', '-b:a', bitrate);
        break;
      case 'flac':
        args.push('-c:a', 'flac');
        break;
      case 'ogg':
        args.push('-c:a', 'libvorbis', '-b:a', bitrate);
        break;
      default:
        args.push('-b:a', bitrate);
        break;
    }

    if (sampleRate) {
      args.push('-ar', String(sampleRate));
    }
    if (channels) {
      args.push('-ac', String(channels));
    }

    args.push(outputPath);

    console.log(`[audioConvert] 执行转码: ${ffmpegPath} ${args.join(' ')}`);
    const { stderr } = await runFFmpeg(ffmpegPath, args);

    if (!fs.existsSync(outputPath)) {
      throw new Error('转码输出文件不存在，请检查源文件是否损坏');
    }

    const outputStats = fs.statSync(outputPath);
    const duration = extractDuration(stderr);
    console.log(`[audioConvert] 转码成功, 输出大小: ${(outputStats.size / 1024).toFixed(1)} KB, 时长: ${duration}s`);

    // 上传转码后的结果至云存储
    const baseName = fileName ? path.parse(fileName).name : 'audio_converted';
    const cloudTargetName = `${baseName}_${randomSuffix.slice(-4)}.${format}`;
    const cloudPath = `converted_audios/${cloudTargetName}`;

    const uploadRes = await cloud.uploadFile({
      cloudPath,
      fileContent: fs.readFileSync(outputPath),
    });

    // 获取下载用临时 URL (有效时间 2 小时)
    let downloadUrl = '';
    try {
      const urlRes = await cloud.getTempFileURL({ fileList: [uploadRes.fileID] });
      if (urlRes.fileList && urlRes.fileList[0]) {
        downloadUrl = urlRes.fileList[0].tempFileURL;
      }
    } catch (urlErr) {
      console.warn('获取临时链接警告:', urlErr);
    }

    // 自动清理源临时文件以节省用户云存储空间
    if (autoCleanSource && fileID.startsWith('cloud://')) {
      cloud.deleteFile({ fileList: [fileID] }).catch(err => {
        console.warn('清理源临时文件警告:', err);
      });
    }

    const costTimeMs = Date.now() - startTime;

    return {
      success: true,
      data: {
        fileID: uploadRes.fileID,
        downloadUrl,
        fileName: cloudTargetName,
        targetFormat: format,
        targetSize: outputStats.size,
        sourceSize: inputStats.size,
        duration,
        costTimeMs,
      },
    };
  } catch (err) {
    console.error('[audioConvert] 转码异常:', err);
    return {
      success: false,
      code: 'CONVERT_FAILED',
      errorMessage: err.message || '音频转码失败，请确认音频未损坏且格式合法',
    };
  } finally {
    // 强制清理容器内部 /tmp 临时文件，防止内存或磁盘泄露
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    } catch (e) {}
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (e) {}
  }
};
