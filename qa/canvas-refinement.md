# Canvas refinement browser QA

日期：2026-09-10

## 环境

- Chromium 138（Playwright build 1179）
- 正式站点：隔离 SQLite、隔离 storage、worker 关闭
- Demo：`python3 -m http.server`，仅同源虚构素材
- 真实 Provider / 付费 API 调用：**0**

## 自动化浏览器证据

执行：

```bash
NODE_PATH=/tmp/ai-image-hub-pw/node_modules /tmp/ai-image-hub-pw/node_modules/.bin/playwright test tests/canvas-refinement.spec.js tests/formal-canvas-refinement.spec.js --reporter=line --workers=1
```

结果：6 passed。正式站点及 Demo 均覆盖交互主路径；两者均在 1440×960、1024×900、768×900、375×812 检查横向溢出并留存截图。

## 验证矩阵

1. Minimap：节点数/可见区域来自实时布局；点击重定位；375px 初始收起且“导航”按钮可展开。
2. 项目：使用正式 `/projects` 表单创建，切换后节点/视口独立；Demo 使用独立 localStorage 项目对象。
3. 连线：上传 3:1、1:3 图，连接输入端口；zoom 1、非 1、拖动、请求收展后，DOM 端口中心与 path 数据端点差值均断言 ≤1.5 CSS px。
4. 拖动：节点通过 pointer 事件移动；原生 drag 仅保留输入缩略图排序。
5. 选择/键盘：多选与多节点移动；正式站点验证 Ctrl+A/C/V、Delete；Demo 验证选择移动及快捷键帮助。
6. 平台 · 模型：分组 listbox、禁用模型、切换模型后能力兼容规格回算。
7. 菜单：画布/节点 context menu 命令与视口边缘 clamp。
8. 预览：`object-fit: contain`；3:1 与 1:3 intrinsic ratio 断言通过。
9. 大图：双击打开原生 dialog；contain、Escape 关闭、原图/下载入口存在。
10. 详情：请求选中展开；结果选中显示锚定“生成详情”。

附加检查：浏览器 console/pageerror 为零；资源 origin 全部同源；无 document 横向溢出；项目恢复节点数断言通过。

## 截图

- Demo：`1440x960.png`、`1024x900.png`、`768x900.png`、`375x812.png`
- 正式站点：`formal-1440x960.png`、`formal-1024x900.png`、`formal-768x900.png`、`formal-375x812.png`
