# VisionEcho 前端开发说明

[English](FRONTEND.md) | [简体中文](FRONTEND.zh-CN.md)

前端是 React 19 与 TypeScript 单页应用，使用 Vite 8 构建，结合 Fluent UI 组件、Lucide 图标、Tailwind CSS 和应用样式。页面包括项目介绍、工作区访问、作品列表和制作编辑器。

## 应用结构

| 文件或目录 | 职责 |
|---|---|
| `src/main.tsx`、`src/App.tsx` | 挂载 React、界面偏好、访问入口和工作区。 |
| `src/components/AccessGate.tsx`、`src/accessSession.ts` | 加载本地或托管会话；在托管模式下提供访客入口、账号表单与会话刷新。 |
| `src/pageNavigation.ts` | 通过 URL hash 协调介绍页分区与工作区导航，不使用路由库。 |
| `src/components/LandingPage.tsx` | 项目介绍与原片／口述版演示样片。 |
| `src/components/LandingTimingDemo.tsx`、`LandingImpact.tsx`、`useLandingMotion.ts` | 口述时机说明、无障碍内容与介绍页动画，包括减少动态效果的偏好处理。 |
| `src/components/LocalVideoWorkspace.tsx` | 作品列表、搜索筛选、项目整理、上传、设置与回收站。 |
| `src/components/workspace/ProjectStudio.tsx` | 协调准备、生成、校对、导出阶段，管理播放器、版本与编辑状态。 |
| `src/components/workspace/StudioProgress.tsx` | 生成步骤与处理进度。 |
| `src/components/workspace/StudioReviewPanel.tsx`、`useStudioReview.ts` | 段落审校状态、风险筛选、文字修改和用户发起的模型改写。 |
| `src/components/workspace/EvidencePanel.tsx` | 参考帧、原片跳转与已保存的画面纠错反馈。 |
| `src/components/workspace/CharacterPanel.tsx`、`characterUtils.ts` | 人物卡、检测结果、称呼确认与替换预览。 |
| `src/components/workspace/ComparisonPreview.tsx`、`timeline.ts` | 原声／口述版对比，以及扩展口述的原片／成片时间映射。 |
| `src/components/workspace/subtitleDisplay.ts` | 字幕校验、说话人标签与重叠字幕显示。 |
| `src/components/workspace/StudioQualityReport.tsx`、`StudioExportMenu.tsx` | 导出页面和格式选择。`StudioQualityReport` 虽然沿用此文件名，实际是导出面板，不提供自动质量评分。 |
| `src/api.ts`、`src/localWorkspaceApi.ts`、`src/types.ts` | 同源 API 传输、上传请求、带类型的工作区操作与数据约定。 |
| `src/UiPreferencesProvider.tsx`、`src/uiPreferences.ts` | 界面语言、主题持久化与 Fluent UI 主题变量。 |
| `src/workspace.css`、`src/ui-theme.css`、组件 CSS 文件 | 工作区布局、亮暗主题及介绍页、访问入口、编辑器各模块样式。 |

## 本地开发

从仓库根目录运行 `./run-local.sh` 可同时启动前后端。单独启动前端时，先让 FastAPI 后端运行于 `127.0.0.1:8000`，再执行：

```bash
cd dashboard/frontend
npm ci
npm run dev
```

Vite 开发和预览服务器监听 `127.0.0.1:5174`，将 `/api/*`（包括上传与媒体请求）转发至后端。无需前端模式变量。根地址打开介绍页；会话允许访问时，`#visionecho-content` 打开工作区。详见[本地运行说明](../../RUN-LOCAL.zh-CN.md)。

## 状态与 API 约定

- React 状态保存当前作品、版本选择和未保存编辑。后端保存项目、任务、媒体、已保存字幕、画面纠错、人物卡与审校记录。生成进度通过后端轮询更新。
- 新生成、重新配音均创建新版本。字幕与审校保存携带修订号，拒绝过期写入；放弃未保存编辑前会提示确认。
- 原片对白语言、解说语言与界面语言独立。对白选项包括自动识别、中文、英文和无对白。更换音色时保持当前版本的口述稿语言。
- 字幕支持新增、删除行，修改文字、起止时间和说话人标签。仅不同且已确定的说话人可有重叠字幕。保存后更新预览与字幕下载，不会烧录进 MP4。
- 扩展口述会增加成片时长。播放、参考帧跳转与字幕显示必须使用对应的原片或成片时间；统一在 `timeline.ts` 处理转换。
- 段落改写先更新编辑草稿，修改后的口述稿需要重新配音才能保存为新视频版本。审校状态用于整理纠错，不阻止文件下载。
- 导出菜单下载已保存的 MP4、对白 SRT/VTT 或已配音段落的 TXT 口述稿，不包含尚未保存的修改。
- 界面语言与主题使用浏览器本地存储。重新进入介绍页默认使用英文；直接进入工作区恢复已保存的中文或英文偏好。两种入口均恢复主题选择。
- API 使用同源 `/api` 地址。`api.ts` 在 HTTP 401 时通知会话过期，不自动重试写入请求。托管访问依赖服务端会话，部署与工作区隔离由后端负责。

## 构建与验证

```bash
npm run build
npm test
npm run lint
```

构建先执行 TypeScript 检查，再输出静态文件至 `dist/`。Vitest 使用 jsdom 与 Testing Library；测试位于组件旁及 `src/__tests__/`。`npm run preview` 可预览构建结果，仍需后端运行。部署静态前端时，也需要将同源 `/api` 请求路由至配置好的后端，详见[部署说明](../../deploy/README.zh-CN.md)。

## 配置与演示素材

Azure 凭据仅由后端从仓库根目录的 `.env.local` 或服务器环境变量读取。不可放入前端代码或 `VITE_*` 变量；向客户端暴露的 Vite 变量会进入构建产物。`GET /api/health` 返回配置状态、可用语言和上传限制，不执行实时 Azure 连接测试。

`public/assets/landing/` 中的介绍页媒体是预制演示，不是 Azure 生成流程的实际输出。素材来源、许可与制作方式应随文件保留，详见[演示素材来源](public/assets/landing/SOURCE.zh-CN.md)。
