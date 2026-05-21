import _ from 'lodash';
import fs from 'fs-extra';
import axios from 'axios';
import FormData from 'form-data';

import Request from '@/lib/request/Request.ts';
import chat from '@/api/controllers/chat.ts';
import { isAnonymousModeEnabled, selectToken } from '@/api/middleware/auth.ts';
import logger from '@/lib/logger.ts';

// 与 chat.ts 中 FAKE_HEADERS 完全一致的 headers
const UPLOAD_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: "https://www.stepfun.com",
  "Connect-Protocol-Version": "1",
  "Oasis-Appid": "10200",
  "Oasis-Mode": "2",
  "Oasis-Platform": "web",
  Referer: "https://www.stepfun.com/chats/new",
  "Sec-Ch-Ua":
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "X-Waf-Client-Type": "fetch_sdk"
};

export default {

  prefix: '/v1/upload',

  post: {

    '/file': async (request: Request) => {
      request
        .validate('files.file', _.isObject)
      if (!isAnonymousModeEnabled()) request.validate('headers.authorization', _.isString);

      const files = request.files as any;
      const file = files.file;
      const fileArr = Array.isArray(file) ? file : [file];
      const firstFile = fileArr[0];
      const refreshToken = selectToken(request.headers.authorization || '');
      const isImage = firstFile.mimetype && firstFile.mimetype.startsWith("image/");
      const uploadUrl = isImage
        ? "https://www.stepfun.com/api/resource/image"
        : "https://www.stepfun.com/api/resource/document";

      logger.info(`Uploading file: ${firstFile.originalFilename} (${firstFile.mimetype})`);

      // 通过 refreshToken 获取有效的 accessToken（与 chat.ts 中 uploadFile 一致）
      const auth = await chat.acquireToken(refreshToken);

      const fileData = await fs.readFile(firstFile.filepath);

      // 使用 form-data 库构建 multipart
      const form = new FormData();
      form.append("file", fileData, {
        filename: firstFile.originalFilename || "upload",
        contentType: firstFile.mimetype || "application/octet-stream"
      });
      form.append("scene_id", isImage ? "image" : "file");
      form.append("mime_type", firstFile.mimetype || "application/octet-stream");

      logger.info(`Uploading to ${uploadUrl}`);

      // 清理临时文件
      for (const f of fileArr) {
        try { await fs.unlink(f.filepath); } catch (_) { /* ignore */ }
      }

      // 使用 axios 发送（与 chat.ts 中 uploadFile 完全一致的 headers）
      const result = await axios.post(uploadUrl, form, {
        maxBodyLength: 100 * 1024 * 1024,
        timeout: 60000,
        headers: {
          Cookie: auth.cookie || `Oasis-Token=${auth.token}; Oasis-Webid=${auth.deviceId}`,
          "Oasis-Webid": auth.deviceId,
          Referer: "https://www.stepfun.com/chats/new",
          ...UPLOAD_HEADERS,
          ...form.getHeaders(),
        },
        validateStatus: () => true,
      });

      logger.info(`Upload response status: ${result.status}`);

      const responseData = result.data;

      // 检查是否是HTML响应
      if (_.isString(responseData) && (responseData.includes('<!DOCTYPE html>') || responseData.includes('<html'))) {
        logger.warn(`Response is HTML (first 300 chars): ${String(responseData).substring(0, 300)}`);
        throw new Error(`Upload API returned HTML (status ${result.status}). The API endpoint may have changed or requires different headers.`);
      }

      // 兼容 StepFun API 可能的两种响应格式：
      // 1. 直接返回 { id, url } 或 { url }
      // 2. 封装在 { code, data: { id, url } } 中
      const payload = responseData?.data || responseData;

      if (payload && (payload.url || payload.id)) {
        const fileId = payload.id || payload.url;
        const fileUrl = payload.url || '';
        logger.success(`Upload success: id=${fileId} url=${fileUrl}`);
        return {
          id: fileId,
          url: fileUrl,
          ...payload,
        };
      }

      const errorMsg = responseData?.message || JSON.stringify(responseData).substring(0, 500);
      throw new Error(`Upload failed (${result.status}): ${errorMsg}`);
    },

    '/url': async (request: Request) => {
      request
        .validate('body.url', _.isString)
      if (!isAnonymousModeEnabled()) request.validate('headers.authorization', _.isString);

      const fileUrl = request.body.url;
      const refreshToken = selectToken(request.headers.authorization || '');

      logger.info(`Uploading file from URL: ${fileUrl}`);

      const result = await chat.uploadFile(fileUrl, refreshToken);
      return result;
    }

  }

};
