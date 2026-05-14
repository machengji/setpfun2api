import _ from 'lodash';


export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "step-v1",
                        "object": "model",
                        "owned_by": "step-free-api"
                    },
                    {
                        "id": "step-v1-vision",
                        "object": "model",
                        "owned_by": "step-free-api"
                    },
                    // Claude 兼容模型别名
                    {
                        "id": "claude-sonnet-4-6",
                        "object": "model",
                        "owned_by": "step-free-api"
                    },
                    {
                        "id": "claude-sonnet-4-7",
                        "object": "model",
                        "owned_by": "step-free-api"
                    },
                    {
                        "id": "claude-opus-4-6",
                        "object": "model",
                        "owned_by": "step-free-api"
                    },
                    {
                        "id": "claude-opus-4-7",
                        "object": "model",
                        "owned_by": "step-free-api"
                    },
                    {
                        "id": "claude-haiku-4-5",
                        "object": "model",
                        "owned_by": "step-free-api"
                    }
                ]
            };
        }

    }

}