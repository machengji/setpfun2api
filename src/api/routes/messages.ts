import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { createClaudeMessage, createClaudeMessageStream } from '@/api/controllers/claude.ts';
import { isAnonymousModeEnabled } from '@/api/middleware/auth.ts';

export default {

  post: {

    // POST /v1/messages - Claude Messages API (用于 Claude Code)
    '/v1/messages': async (request: Request) => {
      request
        .validate('body.messages', _.isArray)
      if (!isAnonymousModeEnabled()) request.validate('headers.authorization', _.isString);

      const { model, messages, system, stream, use_search } = request.body;
      const useSearch = use_search !== false;
      const disableToolsStream = stream && request.body.disable_tools_stream === true;
      const tools = disableToolsStream ? undefined : request.body.tools;

      if (stream) {
        const claudeStream = await createClaudeMessageStream(
          model,
          system,
          messages,
          tools,
          request.headers.authorization || '',
          useSearch
        );
        return new Response(claudeStream, {
          type: 'text/event-stream',
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Transfer-Encoding': 'chunked',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      return await createClaudeMessage(
        model,
        system,
        messages,
        tools,
        request.headers.authorization || '',
        useSearch
      );
    },

  },

};
