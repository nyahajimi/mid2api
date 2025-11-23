const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "midgenai-2api",
  PROJECT_VERSION: "1.0.0",
  
  // 安全配置 (从环境变量读取)
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1", 
  
  // 服务器配置
  PORT: parseInt(process.env.PORT || "3000"),
  HOST: process.env.HOST || "0.0.0.0",
  
  // 上游服务配置
  UPSTREAM_URL: "https://www.midgenai.com/api/image-generate",
  ORIGIN_URL: "https://www.midgenai.com",
  REFERER_URL: "https://www.midgenai.com/text-to-image",
  
  // 模型列表
  MODELS: [
    "midgen-v1",
    "midgen-flux",
    "midgen-turbo"
  ],
  DEFAULT_MODEL: "midgen-v1",

  // 默认生成参数
  DEFAULT_STEPS: 100,
  DEFAULT_ASPECT_RATIO: "1:1"
};

// --- HTTP 请求辅助函数 ---

/**
 * 发送 HTTPS POST 请求
 */
function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, body: body });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 读取请求体
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// --- 核心业务逻辑 ---

/**
 * 核心：执行上游图像生成请求
 */
async function performGeneration(prompt, aspectRatio, steps, seed) {
  const payload = {
    prompt: prompt,
    negative_prompt: "",
    aspect_ratio: aspectRatio || CONFIG.DEFAULT_ASPECT_RATIO,
    steps: steps || CONFIG.DEFAULT_STEPS,
    seed: seed || 0
  };

  const headers = {
    "Origin": CONFIG.ORIGIN_URL,
    "Referer": CONFIG.REFERER_URL,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Priority": "u=1, i"
  };

  const response = await httpsPost(CONFIG.UPSTREAM_URL, payload, headers);

  if (!response.body) {
    throw new Error("上游未返回数据");
  }

  const data = response.body;
  
  if (data.blocked) {
    throw new Error(`内容被拦截: ${data.error}`);
  }
  if (!data.image) {
    throw new Error("上游未返回图像数据");
  }

  return data.image;
}

/**
 * 辅助：解析 OpenAI size 到 Midgen aspect_ratio
 */
function mapSizeToAspectRatio(size) {
  if (!size) return "1:1";
  if (size === "1024x1024") return "1:1";
  if (size === "1024x1792") return "9:16";
  if (size === "1792x1024") return "16:9";
  const parts = size.split('x');
  if (parts.length === 2) {
    const [w, h] = parts.map(Number);
    if (w > h) return "16:9";
    if (h > w) return "9:16";
  }
  return "1:1";
}

// --- API 处理函数 ---

/**
 * 处理 /v1/models
 */
function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'midgenai-2api',
    })),
  };
  return { statusCode: 200, body: modelsData };
}

/**
 * 处理 /v1/chat/completions
 */
async function handleChatCompletions(body, requestId) {
  const messages = body.messages || [];
  const lastMsg = [...messages].reverse().find(m => m.role === 'user');
  if (!lastMsg) throw new Error("未找到用户消息");

  const prompt = lastMsg.content;
  let aspectRatio = "1:1";
  let steps = CONFIG.DEFAULT_STEPS;
  let cleanPrompt = prompt;

  if (prompt.includes("--ar 16:9")) { 
    aspectRatio = "16:9"; 
    cleanPrompt = prompt.replace("--ar 16:9", "").trim(); 
  } else if (prompt.includes("--ar 9:16")) { 
    aspectRatio = "9:16"; 
    cleanPrompt = prompt.replace("--ar 9:16", "").trim(); 
  }
  
  const imageBase64 = await performGeneration(cleanPrompt, aspectRatio, steps, 0);
  const markdownImage = `![Generated Image](data:image/jpeg;base64,${imageBase64})`;
  
  if (body.stream) {
    const chunks = [
      {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model || CONFIG.DEFAULT_MODEL,
        choices: [{ index: 0, delta: { content: markdownImage }, finish_reason: null }]
      },
      {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model || CONFIG.DEFAULT_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      }
    ];
    
    return {
      statusCode: 200,
      isStream: true,
      chunks: chunks
    };
  } else {
    return {
      statusCode: 200,
      body: {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || CONFIG.DEFAULT_MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content: markdownImage },
          finish_reason: "stop"
        }]
      }
    };
  }
}

/**
 * 处理 /v1/images/generations
 */
async function handleImageGenerations(body, requestId) {
  const prompt = body.prompt;
  const size = body.size || "1024x1024";
  const aspectRatio = mapSizeToAspectRatio(size);
  
  const imageBase64 = await performGeneration(prompt, aspectRatio, CONFIG.DEFAULT_STEPS, 0);
  
  return {
    statusCode: 200,
    body: {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: imageBase64 }]
    }
  };
}

// --- HTTP 服务器 ---

/**
 * CORS 头部
 */
function getCorsHeaders(additionalHeaders = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...additionalHeaders
  };
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, statusCode, data, additionalHeaders = {}) {
  res.writeHead(statusCode, getCorsHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    ...additionalHeaders
  }));
  res.end(JSON.stringify(data));
}

/**
 * 发送错误响应
 */
function sendError(res, statusCode, message, code) {
  sendJson(res, statusCode, {
    error: { message, type: 'api_error', code }
  });
}

/**
 * 发送流式响应
 */
function sendStream(res, chunks) {
  res.writeHead(200, getCorsHeaders({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  }));

  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * 主请求处理器
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, getCorsHeaders());
    res.end();
    return;
  }

  // 健康检查
  if (url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', version: CONFIG.PROJECT_VERSION });
    return;
  }

  // 主页
  if (url.pathname === '/') {
    res.writeHead(200, getCorsHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Midgen AI 2 API</title></head><body><h1>Midgen AI to OpenAI API Adapter</h1><p>Version: ' + CONFIG.PROJECT_VERSION + '</p><p>API Endpoints:</p><ul><li>GET /v1/models</li><li>POST /v1/chat/completions</li><li>POST /v1/images/generations</li></ul></body></html>');
    return;
  }

  // API 路由
  if (url.pathname.startsWith('/v1/')) {
    // 鉴权
    const authHeader = req.headers.authorization;
    if (CONFIG.API_MASTER_KEY && CONFIG.API_MASTER_KEY !== "1") {
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        sendError(res, 401, '需要 Bearer Token 认证。', 'unauthorized');
        return;
      }
      const token = authHeader.substring(7);
      if (token !== CONFIG.API_MASTER_KEY) {
        sendError(res, 403, '无效的 API Key。', 'invalid_api_key');
        return;
      }
    }

    const requestId = `req-${crypto.randomUUID()}`;

    try {
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const result = handleModelsRequest();
        sendJson(res, result.statusCode, result.body);
      } else if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await handleChatCompletions(body, requestId);
        if (result.isStream) {
          sendStream(res, result.chunks);
        } else {
          sendJson(res, result.statusCode, result.body);
        }
      } else if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await handleImageGenerations(body, requestId);
        sendJson(res, result.statusCode, result.body);
      } else {
        sendError(res, 404, `不支持的 API 路径: ${url.pathname}`, 'not_found');
      }
    } catch (error) {
      console.error('Error:', error);
      sendError(res, 500, error.message, 'generation_failed');
    }
  } else {
    sendError(res, 404, `路径未找到: ${url.pathname}`, 'not_found');
  }
}

// --- 启动服务器 ---

const server = http.createServer(handleRequest);

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`🚀 ${CONFIG.PROJECT_NAME} v${CONFIG.PROJECT_VERSION}`);
  console.log(`📡 Server listening on http://${CONFIG.HOST}:${CONFIG.PORT}`);
  console.log(`🔑 API Key: ${CONFIG.API_MASTER_KEY === "1" ? "未设置 (开发模式)" : "已配置"}`);
  console.log(`📝 Endpoints:`);
  console.log(`   - GET  /v1/models`);
  console.log(`   - POST /v1/chat/completions`);
  console.log(`   - POST /v1/images/generations`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
