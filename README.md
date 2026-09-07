# AI Image Hub

公司部门内部使用的多平台 AI 生图工作台。第一阶段统一接入 Lovart、LibTV 和
OpenAI Images 兼容 API。系统将用户原始提示词直接提交给所选模型，不做提示词扩写。

## 已实现

- 部门账号登录、管理员创建/停用账号、用户数据隔离
- Lovart、LibTV、OpenAI Images 兼容 API 三类执行器
- 模型能力驱动的平台、模型、比例和质量选择
- 最多 14 张参考图，校验格式、尺寸和文件大小
- 持久化任务队列、进程中断保护、有限的安全重试
- 每次提交不可变记录原始提示词、参数、参考图顺序和父任务关系
- 个人提示词历史搜索、平台/结果标记筛选、一键再次使用
- 成功结果的“满意 / 采用 / 不满意”三态标记
- 结果预览与下载、管理端任务和模型连接状态
- 前端不使用 CDN、外部字体、遥测或第三方脚本

## 启动

```bash
cp .env.example .env
# 必须修改 SESSION_SECRET、管理员密码，并填写实际平台凭据
uv sync --dev
uv run uvicorn image_hub.app:app --host 0.0.0.0 --port 5190
```

打开 `http://服务器地址:5190`。首次启动根据 `.env` 创建管理员账号。管理员密码只在
首次建库时使用；修改已有管理员密码需要通过管理脚本或数据库迁移完成。

也可以使用容器启动：

```bash
docker compose up -d --build
```

Compose 默认挂载本机现有的 LibTV CLI 和 Lovart 适配脚本；如果部署到其他服务器，需按
实际路径调整两个只读挂载。

## 配置图像 API

`IMAGE_HUB_OPENAI_IMAGE_MODELS` 使用逗号分隔，每项格式为 `模型ID|显示名称`：

```env
IMAGE_HUB_OPENAI_IMAGE_MODELS=doubao-seedream-5-0-pro-260628|Seedream 5.0 Pro,gpt-image-1|GPT Image 1
```

这类上游需兼容 `POST /images/generations`。API Key 只保存在服务端环境变量中，不会发送
到浏览器。

## 数据目录

- SQLite：`data/image-hub.db`
- 参考图与结果：`storage/generations/<generation-id>/`

正式多人环境建议将数据库切换为 PostgreSQL，并把 `storage` 挂载到持久卷或内部对象存储。

## 验证

```bash
uv run ruff check src tests
uv run pytest -q
```

## 隐私边界

浏览器只访问部署本系统的同源服务。只有后端执行器会按管理员配置访问 Lovart、LibTV 或
图像 API 上游；页面没有 CDN、外部字体、图标服务、分析脚本或遥测。提示词和图片属于内部
数据，应通过内网、HTTPS、服务器访问控制和定期备份保护。
