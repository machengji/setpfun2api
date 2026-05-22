import fs from 'fs';
import path from 'path';

// 1. 自动读取并加载 .env 配置文件，若不存在则自动生成默认配置模板
function loadDotEnv() {
  const dotenvPath = path.join(path.resolve(), '.env');
  if (fs.existsSync(dotenvPath)) {
    try {
      const content = fs.readFileSync(dotenvPath, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index > 0) {
          const key = trimmed.slice(0, index).trim();
          const val = trimmed.slice(index + 1).trim();
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
      console.log(`[环境初始化] 成功加载本地配置文件: ${dotenvPath}`);
    } catch (err: any) {
      console.error(`[环境警告] 加载 .env 配置文件失败: ${err.message}`);
    }
  } else {
    try {
      const defaultEnv = [
        '# StepFun 免账号匿名模式默认开启',
        'STEPFUN_ANONYMOUS_MODE=1',
        '',
        '# 预热匿名账号池大小，默认 8',
        'STEPFUN_ANONYMOUS_POOL_SIZE=8',
        '',
        '# 匿名账号每 3 轮自动轮换',
        'STEPFUN_ANONYMOUS_ROTATE_AFTER=3',
        '',
        '# 触发上下文压缩的默认字符起征点（120k 上限）',
        'STEPFUN_CURRENT_INPUT_FILE_MIN_CHARS=120000',
        '',
        '# 单次流式网络超时时间，默认 120 秒',
        'STEPFUN_STREAM_TIMEOUT_MS=120000',
        '',
        '# 有账号模式下，每个账号连续对话 6 次后换下一个账号',
        'STEPFUN_MEMBER_ROTATE_AFTER=6',
        ''
      ].join('\n');
      fs.writeFileSync(dotenvPath, defaultEnv, 'utf-8');
      
      process.env.STEPFUN_ANONYMOUS_MODE = "1";
      process.env.STEPFUN_ANONYMOUS_POOL_SIZE = "8";
      process.env.STEPFUN_ANONYMOUS_ROTATE_AFTER = "3";
      process.env.STEPFUN_CURRENT_INPUT_FILE_MIN_CHARS = "120000";
      process.env.STEPFUN_STREAM_TIMEOUT_MS = "120000";
      process.env.STEPFUN_MEMBER_ROTATE_AFTER = "6";
      console.log(`[环境初始化] 未检测到 .env 配置文件，已为您自动生成默认配置！`);
    } catch (err: any) {
      console.error(`[环境警告] 自动生成默认 .env 配置文件失败: ${err.message}`);
    }
  }
}

// 2. 自动检测并生成 configs/dev/ 目录和默认的 yml 配置文件，防弹防闪退
function ensureConfigs() {
  const configsDevPath = path.join(path.resolve(), 'configs', 'dev');
  if (!fs.existsSync(configsDevPath)) {
    try {
      fs.mkdirSync(configsDevPath, { recursive: true });
      console.log(`[配置初始化] 成功创建配置目录: ${configsDevPath}`);
    } catch (err: any) {
      console.error(`[配置警告] 创建配置目录失败: ${err.message}`);
    }
  }

  const serviceYmlPath = path.join(configsDevPath, 'service.yml');
  if (!fs.existsSync(serviceYmlPath)) {
    try {
      const defaultServiceYml = [
        '# 服务名称',
        'name: step-free-api',
        '# 服务绑定主机地址',
        'host: \'0.0.0.0\'',
        '# 服务绑定端口',
        'port: 8001'
      ].join('\n');
      fs.writeFileSync(serviceYmlPath, defaultServiceYml, 'utf-8');
      console.log(`[配置初始化] 成功写出默认服务配置文件: ${serviceYmlPath}`);
    } catch (err: any) {
      console.error(`[配置警告] 写出默认服务配置文件失败: ${err.message}`);
    }
  }

  const systemYmlPath = path.join(configsDevPath, 'system.yml');
  if (!fs.existsSync(systemYmlPath)) {
    try {
      const defaultSystemYml = [
        '# 是否开启请求日志',
        'requestLog: true',
        '# 临时目录路径',
        'tmpDir: ./tmp',
        '# 日志目录路径',
        'logDir: ./logs',
        '# 日志写入间隔（毫秒）',
        'logWriteInterval: 200',
        '# 日志文件有效期（毫秒）',
        'logFileExpires: 2626560000',
        '# 公共目录路径',
        'publicDir: ./public',
        '# 临时文件有效期（毫秒）',
        'tmpFileExpires: 86400000'
      ].join('\n');
      fs.writeFileSync(systemYmlPath, defaultSystemYml, 'utf-8');
      console.log(`[配置初始化] 成功写出默认系统配置文件: ${systemYmlPath}`);
    } catch (err: any) {
      console.error(`[配置警告] 写出默认系统配置文件失败: ${err.message}`);
    }
  }
}

// 立即执行以保证后续加载环境无懈可击
loadDotEnv();
ensureConfigs();
