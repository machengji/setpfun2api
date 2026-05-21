import _ from 'lodash';
import { PassThrough } from 'stream';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import { isAnonymousModeEnabled, selectToken } from '@/api/middleware/auth.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.messages', _.isArray)
            if (!isAnonymousModeEnabled()) request.validate('headers.authorization', _.isString);
            const token = selectToken(request.headers.authorization || '');
            const model = request.body.model;
            const messages =  request.body.messages;
            const disableToolsStream = request.body.disable_tools_stream === true;
            const tools = request.body.stream && disableToolsStream ? undefined : request.body.tools;
            const toolChoice = request.body.stream && disableToolsStream ? undefined : request.body.tool_choice;
            const hasTools = Array.isArray(tools) && tools.length > 0;
            const toolBufferMode = hasTools && process.env.STEPFUN_TOOL_BUFFER_MODE !== '0';
            if (request.body.stream) {
                if (toolBufferMode) {
                    // 有工具时：非流式拿完整结果，再包成 SSE 推给客户端
                    const result: any = await chat.createCompletion(model, messages, token, request.body.use_search, tools, toolChoice);
                    const sseStream = new PassThrough();
                    const chunk = {
                        id: result.id,
                        model: result.model,
                        object: 'chat.completion.chunk',
                        created: result.created,
                        choices: (result.choices || []).map((c: any) => ({
                            index: c.index,
                            delta: c.message || {},
                            finish_reason: c.finish_reason,
                        })),
                        usage: result.usage,
                    };
                    sseStream.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    sseStream.end('data: [DONE]\n\n');
                    return new Response(sseStream, {
                        type: "text/event-stream",
                        headers: {
                            "Content-Type": "text/event-stream; charset=utf-8",
                            "Cache-Control": "no-cache, no-transform",
                            Connection: "keep-alive",
                            "Transfer-Encoding": "chunked",
                            "X-Accel-Buffering": "no"
                        }
                    });
                }
                const stream = await chat.createCompletionStream(model, messages, token, request.body.use_search, tools, toolChoice);
                return new Response(stream, {
                    type: "text/event-stream",
                    headers: {
                        "Content-Type": "text/event-stream; charset=utf-8",
                        "Cache-Control": "no-cache, no-transform",
                        Connection: "keep-alive",
                        "Transfer-Encoding": "chunked",
                        "X-Accel-Buffering": "no"
                    }
                });
            }
            else
                return await chat.createCompletion(model, messages, token, request.body.use_search, tools, toolChoice);
        }

    }

}