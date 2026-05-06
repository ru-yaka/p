# P

项目管理工具 - 快速创建和管理项目。

## 安装

```bash
bun install -g ru-yaka/p
```

安装完成后，运行 `p` 命令即可使用。

> **AI 命名功能**需要配置智谱 API Key，见下方[配置说明](#配置)。

### 从源码安装

```bash
git clone https://github.com/ru-yaka/p.git
cd p
bun install
bun run link
```

### 更新

```bash
p update
```

## 命令

| 命令 | 说明 |
|------|------|
| `p new <name>` | 创建新项目 |
| `p new -d "描述"` | AI 生成项目名称 |
| `p clone <url> [name]` | 克隆远程仓库到 p 管理 |
| `p copy <path> [name]` | 复制目录作为新项目 |
| `p add <path>` | 添加现有项目 |
| `p ls` | 列出所有项目 |
| `p open [name]` | 打开项目（实时搜索） |
| `p open [name] -i <ide>` | 用指定 IDE 打开 |
| `p open . -i <ide>` | 用指定 IDE 打开当前目录 |
| `p open :<ide>` | 快速用指定 IDE 打开当前目录 |
| `p rename [old] [new]` | 重命名项目 |
| `p delete <name>` | 删除项目 |
| `p templates` | 管理模板 |
| `p hooks` | 管理 hooks |
| `p config` | 打开配置文件 |
| `p update` | 更新 p |
| `p unzip [project]` | 解压项目所有 zip 文件 |

## Clone 命令

从 GitHub 克隆仓库：

```bash
# 自动推断项目名
p clone https://github.com/owner/repo.git

# 自定义项目名
p clone https://github.com/owner/repo.git my-project

# 支持 owner/repo 短格式
p clone owner/repo

# 支持 SSH 地址
p clone git@github.com:owner/repo.git

# 支持不带 .git 的 HTTPS 地址
p clone https://github.com/owner/repo

# 别名
p cl <url>
```

自动检查 `git config user.name` 与仓库 owner 是否一致，不一致则提示切换账户。

## Copy 命令

复制本地目录作为新项目：

```bash
# 自动推断项目名（使用目录名）
p copy output/www.shadcnblocks.com/blocks

# 自定义项目名
p copy ./my-dir my-project

# 支持绝对路径
p copy /path/to/directory

# 别名
p cp <path>
```

功能：
- 复制整个目录到 `~/.p/projects/`
- 自动初始化 git
- 用 IDE 打开项目

## Rename 命令

重命名项目：

```bash
# 交互式选择并输入新名称
p rename

# 直接指定
p rename old-name new-name

# 别名
p mv old-name new-name
```

功能：
- 重命名前检查 git 用户与仓库 owner 是否一致
- 如果有 GitHub 远程仓库，自动同步重命名
- 本地目录重命名有 5 秒超时，超时提示关闭 IDE 窗口
- 自动更新元数据

## Unzip 命令

解压项目中所有 zip 文件：

```bash
# 当前目录
p unzip
p unzip .

# 指定项目
p unzip my-project
```

功能：
- 递归查找目录下所有 `.zip` 文件
- 解压到 zip 文件所在目录（文件夹名去掉 `.zip` 后缀）
- 解压成功后自动删除原 zip 文件
- 如果目标目录已存在，会先删除再解压

## AI 命名

使用 AI 生成项目名称：

```bash
# 交互式选择
p new -d "一个博客项目"

# 调试模式（显示首字符响应时间、token 统计）
p new -d "一个博客项目" --debug
```

AI 命名功能支持：
- 实时流式输出名称
- 直接输入自定义名称（无需先选择再输入）
- "换一批"排除已生成的名称

## 实时搜索

`p open`、`p delete`、`p templates add` 支持实时搜索：

- 边输入边筛选
- ↑↓ 选择，Enter 确认
- Esc 取消

## 模板管理

```bash
# 添加当前目录为模板
p templates add .

# 更新模板
p templates update .

# 打开模板目录
p templates
```

## 配置

配置文件位于 `~/.p/config.yaml`。

```yaml
# 默认 IDE
ide: cursor

# 智谱 API Key（用于 AI 命名，必填）
# 在 https://open.bigmodel.cn/ 申请
apiKey: your-api-key

# AI 配置
ai:
  model: glm-4.7-flash  # GLM 模型
  count: 5              # 生成名称数量（5-20）

# Hooks 定义
hooks:
  gitInit:
    command: git init

# 模板配置
templates:
  my-template:
    name: 我的模板
    dir: my-template  # 本地模板目录
    hooks:
      - gitInit
```

### AI 配置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `apiKey` | 智谱 API Key，也可通过 `ZHIPU_API_KEY` 环境变量设置 | - |
| `ai.model` | GLM 模型 | `glm-4.7-flash` |
| `ai.count` | 生成名称数量（5-20） | `5` |
