import logger from './logger.js';
import readline from 'readline';

// 致命错误退出阻断器（防止打包后的 EXE 双击发生闪退，让用户看清错误）
export function fatalExit(err: any, msg = "程序遭遇致命错误已终止") {
  logger.error(`${msg}:`, err);
  
  if ((process as any).pkg) {
    console.log('\n\x1b[31m%s\x1b[0m', '================================================================');
    console.log('\x1b[31m%s\x1b[0m', '🔴 独立二进制运行环境异常崩溃提示 (防闪退守护已激活):');
    console.log('\x1b[33m%s\x1b[0m', `   错误信息: ${err?.message || err}`);
    if (err?.code === 'EADDRINUSE') {
      console.log('\x1b[36m%s\x1b[0m', '   💡 排查建议: 端口已经被占用了！');
      console.log('\x1b[36m%s\x1b[0m', '                您极有可能在后台已经运行了本程序的另一个窗口，或是有其他的');
      console.log('\x1b[36m%s\x1b[0m', '                npm run dev / nodemon / step-free-api 进程正在占用相同端口。');
      console.log('\x1b[36m%s\x1b[0m', '                请检查并关闭冲突的进程，然后再重试双击运行！');
    } else {
      console.log('\x1b[36m%s\x1b[0m', '   💡 排查建议: 请确认您的网络链接、电脑权限以及配置文件是否无误。');
    }
    console.log('\x1b[31m%s\x1b[0m', '================================================================');
    console.log('请按【回车键 (Enter)】安全退出本窗口...');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('', () => {
      rl.close();
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
}

// 允许无限量的监听器
process.setMaxListeners(Infinity);

// 输出未捕获异常
process.on("uncaughtException", (err, origin) => {
    if (err && ((err as any).code === 'EADDRINUSE' || err.message?.includes('listen'))) {
      fatalExit(err, `未捕获的端口监听致命异常 (${origin})`);
    } else {
      logger.error(`An unhandled error occurred: ${origin}`, err);
    }
});
// 输出未处理的Promise.reject
process.on("unhandledRejection", (_, promise) => {
    promise.catch(err => {
      if (err && (err as any).code === 'EADDRINUSE') {
        fatalExit(err, "未捕获的异步端口监听致命异常");
      } else {
        logger.error("An unhandled rejection occurred:", err);
      }
    });
});
// 输出系统警告信息
process.on("warning", warning => logger.warn("System warning: ", warning));
// 进程退出监听
process.on("exit", () => {
    logger.info("Service exit");
    logger.footer();
});
// 进程被kill
process.on("SIGTERM", () => {
    logger.warn("received kill signal");
    process.exit(2);
});
// Ctrl-C进程退出
process.on("SIGINT", () => {
    process.exit(0);
});