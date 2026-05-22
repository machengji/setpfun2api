"use strict";

import "@/lib/envLoader.ts";
import environment from "@/lib/environment.ts";
import config from "@/lib/config.ts";
import "@/lib/initialize.ts";
import server from "@/lib/server.ts";
import routes from "@/api/routes/index.ts";
import logger from "@/lib/logger.ts";

import { fatalExit } from "@/lib/initialize.ts";

const startupTime = performance.now();

(async () => {
  logger.header();

  logger.info("<<<< step free server >>>>");
  logger.info("Version:", environment.package.version);
  logger.info("Process id:", process.pid);
  logger.info("Environment:", environment.env);
  logger.info("Service name:", config.service.name);
  logger.info("StepFun browser mode:", process.env.STEPFUN_BROWSER_MODE === "1" ? "enabled" : "disabled");
  logger.info("StepFun anonymous mode:", (process.env.STEPFUN_ANONYMOUS_MODE === "1" || process.env.STEPFUN_FREE_MODE === "1") ? "enabled" : "disabled");

  server.attachRoutes(routes);
  await server.listen();

  config.service.bindAddress &&
    logger.success("Service bind address:", config.service.bindAddress);

  // 保持前台标准输入流活跃，强行阻断 Windows 自动关闭双击拉起的控制台窗口
  if ((process as any).pkg) {
    logger.info("Control console active. Press Ctrl+C to terminate.");
    process.stdin.resume();
  }
})()
  .then(() =>
    logger.success(
      `Service startup completed (${Math.floor(performance.now() - startupTime)}ms)`
    )
  )
  .catch((err) => fatalExit(err));

