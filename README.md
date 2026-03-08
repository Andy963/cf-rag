# cf-rag（Cloudflare Workers AI + D1 + Vectorize）

一个单 Worker 的 RAG 记忆后端：

- embedding：调用 Cloudflare Workers AI 生成向量
- text storage：把原文 + 元数据落到 D1（`cf-text`）
- vector storage：把向量 + id + 少量可过滤 metadata 落到 Vectorize（`cf-vector`）

> 说明：`migrations/` 只用于初始化 D1 表结构；Worker 运行时不会读取这些 SQL 文件。

## Endpoints

- `GET /`（同 `GET /health`）
- `GET /health`
- `POST /embed`（返回 Workers AI 原始结果，便于调试）
- `POST /v1/embeddings`（OpenAI embeddings 兼容格式）
- `GET /memory/health`
- `POST /memory/index`
- `POST /memory/search`

## 快速开始（部署到你的 Cloudflare 账号）

安装依赖：

```bash
cd cf-rag
npm install
```

准备 `wrangler.toml`：

仓库默认只追踪 `wrangler.toml.example`，你需要复制一份成本地的 `wrangler.toml`（该文件已在 `.gitignore` 中忽略）：

```bash
cp wrangler.toml.example wrangler.toml
```

创建 D1：

```bash
npx wrangler d1 create cf-text
```

把 `wrangler d1 create` 输出的 `database_id` 填回你本地的 `cf-rag/wrangler.toml`。

创建 Vectorize（BGE-M3 维度为 1024）：

```bash
npx wrangler vectorize create cf-vector --dimensions 1024 --metric cosine
```

初始化 D1 schema（应用 migrations）：

```bash
npx wrangler d1 migrations apply cf-text --remote
```

配置鉴权（必填）：

```bash
npx wrangler secret put API_TOKEN
```

部署：

```bash
npm run deploy
```

## 自定义域名（可选）

默认不绑定自定义域名，只会部署到 `workers.dev` 域名上（由 Wrangler 输出）。

如果你需要绑定自己的域名路由，在你本地的 `cf-rag/wrangler.toml` 里取消注释并修改：

```toml
# [[routes]]
# pattern = "emb.example.com/*"
# zone_name = "example.com"
```

## 配置项

- `API_TOKEN`（secret，必填）：统一鉴权 token；未配置时服务直接返回 `500`
- `EMBEDDING_MODEL`（var，可选）：默认 `@cf/baai/bge-m3`
- `RERANK_MODEL`（var，可选）：默认 `@cf/baai/bge-reranker-base`
- `RERANK_DEFAULT_ENABLED`（var，可选）：默认 `false`；设为 `true` 可让 `/memory/search` 默认启用 rerank
- `CORS_ALLOW_ORIGIN`（var，可选）：默认 `*`

## 代码结构（src）

核心思路：按功能分层，避免 `src/index.ts` 变成 God file；其中 memory schema 默认导出名为 `defaultMemorySchema`，你可以替换为自己的 schema 以适配不同的存储字段/过滤逻辑。

```text
src/
  index.ts              # entry + auth + router
  env.ts                # Env typings
  utils.ts              # shared helpers

  api/                  # HTTP layer (request/response)
  ai/                   # Workers AI wrappers
  db/                   # D1 access
  vector/               # Vectorize access
  memory/               # schema + index/search orchestration
```

## 数据模型（D1）

表名：`memory_segments`（见 `cf-rag/migrations/0001_init.sql`）

- `id`：主键；若请求未提供，会基于 `session_id` + `tape` + `text` 派生一个稳定 id
- `text`：原文
- `metadata_json`：原始元数据（完整 JSON）
- `session_id` / `tape`：为过滤与索引做的常用列
- `content_hash`：用于避免重复 embedding/写入
- `created_at` / `updated_at`：毫秒时间戳

## Vectorize metadata（可过滤字段）

写入 Vectorize 的 metadata 会从 `metadata_json` 里投影出少量字段（如果存在）：

- `session_id`（string）
- `tape`（string）
- `kind`（string）
- `chat_id`（number）
- `user_id`（number）

如果你需要在 Vectorize 侧做 filter，建议创建 metadata index（至少 `session_id` / `tape`）：

```bash
npx wrangler vectorize create-metadata-index cf-vector --property-name session_id --type string
npx wrangler vectorize create-metadata-index cf-vector --property-name tape --type string
```

## 调用示例

Health：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" https://<your-worker>/health
```

Embedding（OpenAI 兼容）：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  https://<your-worker>/v1/embeddings \
  -d '{"input":["hello","world"]}'
```

Index memory：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  https://<your-worker>/memory/index \
  -d '{"text":"hello world","metadata":{"session_id":"s1","tape":"t1","kind":"note"}}'
```

Search memory：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  https://<your-worker>/memory/search \
  -d '{"query":"hello","topK":5,"filter":{"session_id":"s1","tape":"t1"}}'
```

## Rerank（可选）

`/memory/search` 默认只按 Vectorize 的向量相似度排序。

如果你希望“召回 + 精排”，可以在请求体里打开 `rerank`，让 Worker 额外调用 Workers AI 的 reranker 模型对候选结果重排（会带来额外延迟与成本）：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  https://<your-worker>/memory/search \
  -d '{"query":"hello","topK":5,"filter":{"session_id":"s1","tape":"t1"},"rerank":{"enabled":true,"topN":20}}'
```

当 rerank 启用时，返回的 match 会额外包含：

- `vector_score`：向量相似度分数
- `rerank_score`：reranker 分数
- `score`：最终用于排序的分数（优先使用 `rerank_score`，否则回退到 `vector_score`）


