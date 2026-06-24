# p

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
