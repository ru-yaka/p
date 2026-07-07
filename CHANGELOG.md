# p

## 1.21.1

### Patch Changes

- 修复 `p new -d` 选择 AI 命名后误报"项目名称不能为空"：校验对象错误地指向了命令行传入的 `cleanName`（在 `-d` 模式下为空），改为统一校验最终选中的 `projectName`。

## 1.21.0

### Minor Changes

- `p push` 修复：当前目录不是 git 仓库时自动 `git init -b main`，不再报 "not a git repository"。创建 GitHub 私有仓库前增加询问，新增 `-a, --auto` 跳过询问。

### Patch Changes

- `p unzip` 输出精简：长哈希后缀截断到 8 位 + `…` 展示，去掉 `(清理自 …)` 后缀。

## 1.20.2

### Patch Changes

- `p unzip` 的 `--remove-prefix` 短选项从 `-r` 改为 `-p`（与 `--remove-suffix`/`-s` 对称，p=prefix 更直观）。

## 1.20.1

### Patch Changes

- `p unzip` 公共前缀检测从全局 LCP 改为按首 token 聚类，避免一个异类把整组共性拉空。询问顺序调整为前缀 → 后缀 → 执行。

## 1.20.0

### Minor Changes

- `p unzip` 公共前缀检测改为基于 dash-token LCP 算法自动推断（不再维护硬编码模板库列表）。当 ≥2 个 zip 共享 dash-token 公共前缀时询问是否移除。

## 1.19.0

### Minor Changes

- `p unzip` 新增清理能力：自动识别并询问是否移除 `-template` 后缀、十六进制哈希后缀、已知模板库前缀（如 `magicuidesign`）。新增 `--auto` 跳过所有询问，`--remove-prefix <name>` / `--remove-suffix <name>` 手动指定要移除的前缀/后缀（可多次）。

## 1.18.0

### Minor Changes

- `p cp` 默认行为改为自动将原始目录移入回收站（不再询问），需要保留原始目录时加 `--no-trash`。`--trash` flag 因此移除。

## 1.17.0

### Minor Changes

- `p cp` 默认不再自动打开 IDE（改为 `-o/--open` 显式触发）；支持逗号分隔多路径一次复制多个项目；新增 `-t/--trash` 和 `--no-trash` flag 控制是否将原始目录移入回收站（多项目时一次询问，要么全移要么全不移）。

## 1.16.0

### Minor Changes

- 新增 `p path <name>` 命令（别名 `p p`、`p pp`），打印项目绝对路径，支持模糊匹配。输出纯路径便于 shell 替换（如 `cd $(p p foo)`），错误走 stderr 不污染 stdout。

## 1.15.1

### Patch Changes

- 修复 `p push` 在无新变更时因 pre-commit hook (如 lefthook) 报错而中断的问题：改用 `git diff --cached --quiet` 检测 staged 变更，无变更则跳过 commit 步骤；并新增未推送 commits 检测，仅在已与远程同步时才提示"无需推送"。

## 1.15.0

### Minor Changes

- 支持 `p rm`/`p delete` 一次性传入多个项目名进行批量删除，每个参数可以是项目名或通配符模式（如 `p rm alpha beta api-*`）。

## 1.6.0

- unzip 支持 -f/--flatten 解解散 zip 内的根目录
- 使用 adm-zip 替代系统 unzip 命令，支持 Windows
- 配置中的 IDE 直接使用，不再扫描 PATH
- 实时搜索：`p open`、`p delete`、`p template add` 使用实时搜索组件
- `p import` 迁移外部项目、`p tag` 项目标签、模糊匹配增强
- AI 命名（智谱 GLM）、模板管理、hooks 系统
