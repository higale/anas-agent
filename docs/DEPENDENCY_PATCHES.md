# UI 依赖补丁

补丁位于 [patches/](../patches)，修改锁文件指定版本的发布代码，ESM 与 CommonJS 同时覆盖。

## 当前补丁

| 依赖版本 | 修复范围 | 回归入口 |
| --- | --- | --- |
| `@radix-ui/react-dismissable-layer@1.1.19` | 嵌套弹层的 Escape 分发 | [项目预览 E2E](../scripts/electron-project-previews.cjs) |

### 嵌套弹层的 Escape

Radix 原实现按渲染时的最高层状态管理 Escape 监听，嵌套弹层显示后、effect 更新前，底层监听仍可能关闭项目设置并丢失草稿。补丁在键盘事件发生时查询 Radix 的当前层集合，只允许最高层处理 Escape；焦点和弹窗生命周期仍由 Radix 管理。

## 安装与升级

`npm ci` 的 postinstall 首先执行 `patch-package --error-on-fail`，补丁失败即中止安装，随后才准备 Electron 和原生模块。开发、测试、构建和打包均使用应用补丁后的依赖；编码评测的源码指纹也包含补丁文件。

升级相关依赖时，先用未应用补丁的目标版本运行对应回归，确认哪些修复已进入上游。删除已不需要的补丁；仍需修复的部分按目标版本重新生成并检查，不能忽略补丁失败或强行套用旧差异。当前本地生成命令：

```sh
npx patch-package @radix-ui/react-dismissable-layer
```

生成后验证干净安装、相关测试和构建。项目预览测试由 `npm run test:e2e` 调用；补丁版本必须与锁文件中实际安装版本一致。
