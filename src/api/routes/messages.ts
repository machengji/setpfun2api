import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { createClaudeMessage, createClaudeMessageStream } from '@/api/controllers/claude.ts';

export default {

  post: {

    // POST /v1/messages - Claude Messages API (用于 Claude Code)
    '/v1/messages': async (request: Request) => {
      request
        .validate('body.messages', _.isArray)
        .validate('headers.authorization', _.isString);

      const { model, messages, system, stream, tools, use_search } = request.body;
      const useSearch = use_search !== false;

      if (stream) {
        const claudeStream = await createClaudeMessageStream(
          model,
          system,
          messages,
          tools,
          request.headers.authorization,
          useSearch
        );
        return new Response(claudeStream, {
          type: 'text/event-stream',
          headers: {
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      return await createClaudeMessage(
        model,
        system,
        messages,
        tools,
        request.headers.authorization,
        useSearch
      );
    },

  },

};
