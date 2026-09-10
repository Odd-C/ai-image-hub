# Canvas usability refinement browser QA

日期：2026-09-10

## 环境

- 真实 Chromium 138（Playwright build 1179）
- 正式站点：`http://127.0.0.1:5190`，隔离 SQLite、隔离 storage、worker 关闭
- Demo：`http://127.0.0.1:4173`，`python3 -m http.server`，仅同源虚构素材
- 真实 Provider / 付费 API 调用：**0**

## 自动化浏览器证据

执行：

```bash
NODE_PATH=/tmp/ai-image-hub-pw/node_modules /tmp/ai-image-hub-pw/node_modules/.bin/playwright test tests/canvas-refinement.spec.js tests/formal-canvas-refinement.spec.js --reporter=line --workers=1
```

结果：**7 passed**。正式站点与 Demo 均覆盖交互主路径；两者均在 1440×960、1024×900、768×900、375×812 留存安全截图。

## 本轮重点验证

1. **请求头与结果操作栏**：请求收展与删除均改为内联 SVG，具有 `aria-label`、`title` 及动态 `aria-expanded`；桌面命中区 ≥28×28，窄屏 ≥36×36；标题/计数截断稳定，hover/focus 不改变头部或 footer 几何，删除危险色只在 hover/focus 出现。
2. **折叠连线几何**：折叠后输入、输出端口在紧凑卡片垂直居中；连线端点基于真实 DOM 中心换算，zoom 1 与非 1 下误差 ≤1.5 CSS px；连续 3 轮收展无 world 坐标漂移，minimap 与连线在布局稳定后重算。
3. **大图查看器**：3:1 与 1:3 图片保持 `contain` 和初始居中适配；覆盖缩小/百分比/放大/适配/100%/原图/下载/关闭，10%–800% 限制、指针中心滚轮缩放、拖拽平移边界、`+`/`-`/`0`/`1`/Escape、重置与焦点恢复；移动端工具栏无横向溢出。
4. **Prompt 一次点击编辑**：先选中结果，使展开请求保持可见但未选中；单击 textarea 后首段唯一字符串完整保留，`activeElement` 为 textarea；切换模型、比例后原 textarea DOM 仍连接，继续输入无丢字。
5. **项目侧栏**：桌面展开 224px、收起 48px；切换后 viewport 宽度恢复，world center 偏差 <1 CSS px，节点 world 坐标不变；minimap 和连线端点继续更新，端点误差 ≤1.5 CSS px。
6. **项目隔离/新建**：正式站点复用 CSRF `POST /projects` 创建并跳转；项目链接使用既有 `/projects/{id}`；切回原项目恢复 3 个节点，第二项目保持独立。Demo 使用独立 localStorage 项目画布对象。
7. **移动抽屉**：768×900 与 375×812 下 canvas 占满可用宽度；项目按钮打开；Escape 与 scrim 均可关闭并更新 `aria-expanded`；无 document 横向溢出。
8. **回归保护**：minimap、端口几何、缩放、请求收展、多选/复制/粘贴/删除、context menu、模型分组、图片 contain、双击 viewer、结果详情继续通过。
9. **安全与运行时**：console error 0、pageerror 0、资源同源、真实 Provider 调用 0。

## 静态与单元门禁

- 当前运行环境无 `uv` 可执行文件，指定的两条 `uv run` 命令无法启动；使用项目 `.venv/bin/ruff check src tests` 等价检查通过
- `.venv/bin/pytest -q`：52 passed，只有 3 条第三方 deprecation warning
- `compileall`：通过
- Demo、canvas-core、app、history 及全部 Playwright spec `node --check`：通过
- `git diff --check`：通过
- `@google/design.md lint DESIGN.md`：0 errors；10 个既有未引用 token warnings，1 条 token summary

## 截图

- Demo：`1440x960.png`、`1024x900.png`、`768x900.png`、`375x812.png`
- 正式站点：`formal-1440x960.png`、`formal-1024x900.png`、`formal-768x900.png`、`formal-375x812.png`
