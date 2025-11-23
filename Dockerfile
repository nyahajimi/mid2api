FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json
#以此行替换之前的 COPY 指令，不需要 package-lock.json 也行
COPY package.json ./

# 安装依赖
# 【修改点】将 npm ci 改为 npm install，这样即使没有 lock 文件也能成功
RUN npm install --production && npm cache clean --force

# 复制应用代码
COPY server.js ./

# 创建非 root 用户 (安全性最佳实践)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# 切换到非 root 用户
USER nodejs

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# 启动应用
CMD ["node", "server.js"]
