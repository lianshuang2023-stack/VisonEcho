# VisionEcho 前端开发说明

前端为 React 19 + TypeScript 单页应用，使用 Vite 8 构建。页面围绕作品管理、口述制作和字幕校对组织。

## 页面与代码

| 文件 | 职责 |
|---|---|
| `src/App.tsx` | 应用入口及运行模式选择 |
| `src/components/LocalVideoWorkspace.tsx` | 我的作品、搜索筛选、项目管理、上传与回收站 |
| `src/components/workspace/ProjectStudio.tsx` | 生成设置、历史版本、播放器、口述稿和字幕编辑 |
| `src/components/workspace/ComparisonPreview.tsx` | 原声与口述版对比预览 |
| `src/components/workspace/timeline.ts` | 原片与扩展口述的时间映射 |
| `src/localWorkspaceApi.ts` | 作品、校准、配音与导出的类型和请求 |
| `src/api.ts` | 上传、媒体地址、执行状态和后端配置请求 |
| `src/UiPreferencesProvider.tsx` | 页面语言与主题状态 |
| `src/workspace.css`、`src/ui-theme.css` | 工作区布局与亮暗主题 |

## 本地运行

从仓库根目录运行 `./run-local.sh` 可同时启动前后端。单独启动前端时，先保证 FastAPI 后端运行于 `127.0.0.1:8000`。

```bash
cd dashboard/frontend
npm ci
VITE_LOCAL_BACKEND=true npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

也可复制 `.env.local.example` 为 `.env.local`。Vite 在开发和预览模式下将 `/api/*` 转发至本地后端，包含上传与视频请求。只有 `VITE_LOCAL_BACKEND=true` 才会启用 VisionEcho 本地工作区。

## 交互与数据

- 页面内保存当前作品与历史版本选择，后端维护作品和生成任务数据。
- 新生成、重新配音均创建新版本；对白字幕保存使用修订号检查，防止覆盖其他窗口的修改。
- 对白语言、解说语言和页面语言相互独立；换音色时保持当前版本的口述稿语言。
- 扩展口述会增加成片时长。原片预览与口述版使用不同时间轴，字幕显示和跳转需使用时间映射。
- 页面语言和主题保存在浏览器本地存储；视频、字幕及版本文件保存在后端工作区。
- 字幕编辑影响预览与 SRT/VTT 下载，不会烧录进 MP4。

## 构建与测试

```bash
VITE_LOCAL_BACKEND=true npm run build
./node_modules/.bin/vitest run
npm run lint
```

生产构建输出到 `dist/`。本地静态服务需要把同源 `/api` 请求转发至 FastAPI，并保持仅监听本机。已知功能限制见[本地运行说明](../../RUN-LOCAL.zh-CN.md#当前已知限制)。

## 配置边界

Azure API 密钥只放在仓库根目录的后端 `.env.local` 中。任何 `VITE_*` 变量都会进入前端构建，不可用于保存密钥。

`GET /api/health` 返回配置是否齐全、可用语言和上传限制；该请求不执行 Azure 连接测试。
