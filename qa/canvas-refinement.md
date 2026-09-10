# Canvas external image and interaction QA

日期：2026-09-10

## 环境与安全边界

- 真实 Chromium 138（Playwright 1.63.0）
- 正式站：`http://127.0.0.1:5190`，隔离 SQLite / storage，worker 关闭
- Demo：`http://127.0.0.1:4173`，同源静态虚构素材
- Console error：0；pageerror：0；document 横向 overflow：0
- 真实 Provider / 付费 API 调用：**0**

## Chromium 证据

执行 Demo 与正式站合并套件：**9 passed**。

- 1440×960、1024×900、768×900、375×812 均已覆盖，并更新同名 `qa/*.png` 截图。
- PNG 拖放、DataTransfer File、clipboard image、文件选择器共享归一化路径；非 100% 缩放的 drop/paste 坐标以 ≤0.001 CSS px 误差断言。
- 多图固定 32px 偏移；natural size、intrinsic ratio 与 `object-fit:contain` 已验证；刷新后保留节点并显示重新选择本地图片状态。
- 文本粘贴保持在 textarea；系统图片优先于内部节点剪贴板；纯 URL/HTML 引用显示 V1 不支持 toast。
- 请求标题栏在展开和收起状态的操作按钮 centerY 差 ≤0.5 CSS px；每种 viewport 验证触控尺寸、非重叠和卡片边界包含（仅允许 ≤0.75px transform rounding）。
- 节点拖动使用 pointer capture、统一 dragging class、pointercancel/Escape 清理和活跃手势范围内的 selectstart 阻止；普通编辑区保留文本选择。

## 静态和单元门禁

- `UV_CACHE_DIR=.uv-cache uv run ruff check src tests`：通过
- `UV_CACHE_DIR=.uv-cache uv run pytest -q`：52 passed（3 条第三方 deprecation warning）
- `python3 -m compileall -q src tests`：通过
- 全部项目 JS、Playwright spec `node --check`：通过
- `git diff --check`：通过
- `npx -y @google/design.md lint DESIGN.md`：0 errors，10 条既有 orphaned-token warnings

## 截图

- Demo：`1440x960.png`、`1024x900.png`、`768x900.png`、`375x812.png`
- 正式站：`formal-1440x960.png`、`formal-1024x900.png`、`formal-768x900.png`、`formal-375x812.png`
