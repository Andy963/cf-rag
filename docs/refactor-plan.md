# cf-rag `src/` 重构计划（按功能拆分）

本文档用于在不改变对外行为的前提下，对 `cf-rag/src` 进行结构性重构，使职责边界更清晰、便于长期维护，并尽量保证单文件代码行数不超过 500 行（目标 200–300 行，超过则继续拆分）。

## 背景与动机

当前 `src/index.ts` 同时承担路由分发、鉴权、D1/Vectorize 读写、embedding、rerank、配置解析等职责，已经接近“God file”。继续迭代会导致：

- 改动一处容易引发非预期回归（缺乏边界隔离）
- 很难复用/替换某一层能力（例如替换 Vectorize 召回策略）
- 单元级别验证困难（大量逻辑耦合在一个模块中）

## 重构目标（必须满足）

- 对外契约不变：
  - endpoints 不变：`/health`、`/embed`、`/v1/embeddings`、`/memory/*`
  - 鉴权不变：强制 `API_TOKEN`；支持 `Authorization: Bearer` 与 `X-Api-Key`
  - D1 表结构不变：`memory_segments` 及其字段
  - Vectorize metadata 投影规则不变（仍由 schema 控制）
  - `filter` 行为不变：Vectorize 过滤 + D1 侧二次校验；候选不足时的 fallback 逻辑保留
  - rerank 行为不变：
    - 请求显式 `rerank: false` 必须能关闭
    - 启用 rerank 返回 `vector_score` / `rerank_score`；`score` 表示最终排序分
- 代码组织更清晰：按功能拆分成 `api/`、`ai/`、`db/`、`vector/`、`memory/`
- 单文件不超过 500 行（软目标：200–300）
- 增量重构：每一步都能 `npm run typecheck` 通过，便于回滚

## 命名与目录约定（已对齐）

- Memory schema 模块导出名统一为：`defaultMemorySchema`
- 存储模块按直觉命名目录：
  - D1：`src/db/`
  - Vectorize：`src/vector/`

## 目标结构（最终形态）

> 说明：这是最终目标结构；实施过程中会分步骤搬迁，避免一次性大爆炸 diff。

```text
src/
  index.ts
  env.ts
  utils.ts

  api/
    http.ts
    router.ts
    embedding.ts
    memory.ts

  ai/
    embedding.ts
    rerank.ts

  db/
    d1.ts

  vector/
    vectorize.ts

  memory/
    schema.ts
    indexer.ts
    searcher.ts
```

## 模块职责（边界清单）

### `src/index.ts`

- Worker 入口：处理 `OPTIONS`
- 读取并强制校验 `API_TOKEN`
- 统一鉴权（失败直接返回 401）
- 调用 `api/router.ts` 完成路由分发

### `src/env.ts`

- 统一定义 Worker `Env` 类型（`AI/DB/SEGMENTS_INDEX/API_TOKEN/...`）
- 避免每个文件重复声明 Env 形状、减少类型漂移

### `src/utils.ts`

- 通用工具函数（例如 `chunkArray`、`clampInt`、`readBoolEnv`、`truncateText`）
- 原则：如果某工具函数只在一个模块使用，则留在该模块；只有跨模块复用才提升到 `utils.ts`

### `src/api/http.ts`

- HTTP 相关基础设施：
  - CORS headers
  - `jsonResponse/textResponse`
  - `parseJson`
  - `isAuthorized/unauthorizedResponse`

### `src/api/router.ts`

- 只做分发，不做业务逻辑：
  - embedding routes -> `api/embedding.ts`
  - memory routes -> `api/memory.ts`

### `src/api/embedding.ts`

- embedding HTTP endpoints 的 handler：
  - `GET /`、`GET /health`
  - `POST /embed`、`POST /v1/embeddings`
- 只负责请求解析/响应格式，不直接触碰 D1/Vectorize

### `src/api/memory.ts`

- memory HTTP endpoints 的 handler：
  - `GET /memory/health`
  - `POST /memory/index` -> 调用 `memory/indexer.ts`
  - `POST /memory/search` -> 调用 `memory/searcher.ts`

### `src/ai/embedding.ts`

- 对 Workers AI embedding 的调用封装：
  - `getEmbeddingModel(env)`
  - `embedTexts(env, texts)`
  - embedding 输出形状解析（兼容不同返回结构）

### `src/ai/rerank.ts`

- 对 Workers AI reranker 的调用封装（默认 `@cf/baai/bge-reranker-base`）：
  - rerank 请求组装（`query` + `contexts`）
  - rerank 输出解析与归一化（`[{ id, score }]`）
- 原则：将“模型输出 shape 不稳定”的兼容逻辑集中在这里，避免污染业务层

### `src/db/d1.ts`

- D1 repo（只做数据访问与 SQL，尽量不掺业务语义）：
  - `fetchExistingHashes(db, ids)`（带 IN 分块）
  - `fetchByIds(db, ids)`（带 IN 分块）
  - `upsertSegments(db, segments)`（带 batch 分块）

### `src/vector/vectorize.ts`

- Vectorize repo（只做向量读写与接口差异收口）：
  - `upsert(index, vectors)`
  - `query(index, vector, options)`
  - `toQueryMatches()`（兼容 `matches/results` 字段差异）

### `src/memory/schema.ts`

- 领域 schema（请求/响应与存储结构的“契约层”）：
  - 请求规范化：index/search body
  - id 派生规则
  - metadata 投影规则（写入 Vectorize 的可过滤字段）
  - filter 规则：D1 二次过滤的语义（保证 correctness）
  - 输出映射：`toSearchMatch`
- 导出约定：`export const defaultMemorySchema = ...`

### `src/memory/indexer.ts`

- 编排 `/memory/index` 业务流程：
  1) normalize items（schema）
  2) D1 查 hash（db）
  3) embedding 分批（ai）
  4) Vectorize upsert（vector）
  5) D1 upsert（db）

### `src/memory/searcher.ts`

- 编排 `/memory/search` 业务流程：
  1) query embedding（ai）
  2) Vectorize recall（vector，含 filter + fallback）
  3) D1 hydrate（db）
  4) D1 side filter verify（schema）
  5) 可选 rerank（ai，默认开关由 env 决定）
  6) 返回 topK

## 依赖方向约束（避免循环依赖）

必须满足单向依赖，建议按层级从上到下：

```text
index.ts
  -> api/*
      -> memory/*
      -> ai/*
      -> db/*
      -> vector/*
      -> api/http.ts

memory/*
  -> memory/schema.ts
  -> ai/*
  -> db/*
  -> vector/*
  -> utils.ts

db/*, vector/*, ai/*
  -> utils.ts (optional)
  -> env.ts (types)
```

禁止出现：

- `db/*` 反向依赖 `memory/*` 的业务流程
- `ai/*` 依赖 `memory/*`（除非仅类型且必要）

## Rerank 默认开启策略（我们自用）

为了“我们自己用的 Worker 默认开启 rerank，同时开源默认不强制启用”：

- 开源仓库追踪 `wrangler.toml.example`，默认不启用 rerank（仅提供可选配置说明）
- 我们本地未追踪的 `wrangler.toml` 配置 `RERANK_DEFAULT_ENABLED="true"`
- 运行时逻辑（代码）遵循：
  - 请求体未包含 `rerank/reranking` 字段：按 `RERANK_DEFAULT_ENABLED` 决定是否启用
  - 请求体显式 `rerank: false`：强制关闭

## 增量实施步骤（每步都可 typecheck）

建议按以下顺序实施，避免一次性大量移动：

1) 新增目录骨架与 `env.ts/utils.ts`（不改行为）
2) `http.ts` -> `api/http.ts`（只改 import 路径）
3) `current-memory-shape.ts` -> `memory/schema.ts`，导出名改为 `defaultMemorySchema`
4) 拆 embedding：`api/embedding.ts` + `ai/embedding.ts`
5) 抽 `db/d1.ts` 与 `vector/vectorize.ts`（先把 SQL/Vectorize 细节收口）
6) 抽 `memory/indexer.ts` 与 `memory/searcher.ts`（把大函数搬出）
7) 引入 `api/memory.ts` 与 `api/router.ts`（统一分发）
8) 清理 `index.ts`：只保留入口/鉴权/分发

每一步后都执行：

```bash
cd cf-rag
npm run typecheck
```

## 验证清单（手动 smoke）

部署前后都建议做一组最小 smoke：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" https://<your-worker>/health
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" https://<your-worker>/v1/embeddings -d '{"input":["ping"]}'
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" https://<your-worker>/memory/index -d '{"text":"pref: short answers","metadata":{"user_id":1,"kind":"preference"}}'
curl -sS -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" https://<your-worker>/memory/search -d '{"query":"user preference","topK":5,"filter":{"user_id":1,"kind":"preference"}}'
```

如果启用 rerank（默认或显式开启），额外确认返回中存在：

- `matches[*].vector_score`
- `matches[*].rerank_score`

## 非目标（本轮不做）

- 不改 D1 schema（不新增/删除列）
- 不做数据迁移/重算向量
- 不改 API contract（字段命名、路径、响应结构保持稳定）

