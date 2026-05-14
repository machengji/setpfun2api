import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import chat from "./chat.ts";
import ping from "./ping.ts";
import token from './token.ts';
import models from './models.ts';
import upload from './upload.ts';
import admin from './admin.ts';
import messages from './messages.ts';

export default [
    {
        get: {
            '/': async () => {
                const content = await fs.readFile('public/welcome.html');
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            }
        }
    },
    chat,
    ping,
    token,
    models,
    upload,
    admin,
    messages
];