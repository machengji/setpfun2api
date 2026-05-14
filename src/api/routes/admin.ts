import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import admin from '@/api/controllers/admin.ts';
import chat from '@/api/controllers/chat.ts';
import { requireAdmin } from '@/api/middleware/auth.ts';

export default {

  prefix: '/admin',

  get: {
    // GET /admin/status - 系统状态
    '/status': async (request: Request) => {
      requireAdmin(request.headers.authorization);
      return admin.getStatus();
    },

    // GET /admin/api-keys - 列出所有 API keys
    '/api-keys': async (request: Request) => {
      requireAdmin(request.headers.authorization);
      return admin.getApiKeys();
    },
  },

  post: {
    // POST /admin/api-keys - 创建 API key
    '/api-keys': async (request: Request) => {
      requireAdmin(request.headers.authorization);
      const { key, name, accounts, remark } = request.body;
      return admin.createApiKey(key, name, accounts, remark);
    },

    // POST /admin/config/reload - 重新加载配置
    '/config/reload': async (request: Request) => {
      requireAdmin(request.headers.authorization);
      return admin.reloadApiConfig();
    },

    '/browser-conversation/reset': async (request: Request) => {
      requireAdmin(request.headers.authorization);
      return chat.resetBrowserConversation();
    },

    // POST /admin/admin-key - 更新管理员密钥
    '/admin-key': async (request: Request) => {
      const currentAuth = request.headers.authorization;
      // 验证当前 admin key
      requireAdmin(currentAuth);
      const { new_key } = request.body;
      return admin.updateAdminKey(new_key);
    },
  },

  delete: {
    // DELETE /admin/api-keys/:key - 删除 API key
    '/api-keys': async (request: Request) => {
      requireAdmin(request.headers.authorization);
      const { key } = request.body;
      if (!key) throw new Error('key is required');
      return admin.deleteApiKey(key);
    },
  },

};
