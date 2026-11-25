# Anas 语言包 / Language Packs

## 中文

此程序包目录保存内置界面语言包，由应用升级维护，直接读取，不复制到用户数据目录：

- `en.json`
- `zh-CN.json`

添加自定义语言：

1. 将包内英文模板复制到应用数据目录的 `lang/`，使用新的语言文件名，例如 `ja.json`、`ko.json`、`fr.json` 或 `pt-BR.json`。
2. 将 `_meta.name` 改为该语言的显示名称。
3. 翻译文本值，保留 `version: 0`、JSON 键和 `{{name}}` 等占位符。
4. 将文件保存为 UTF-8 JSON。
5. 重启或重新打开 Anas，加载语言列表后在设置中选择新语言。

数据目录中旧的 `en.json`、`zh-CN.json` 原样保留但不加载；自定义语言请使用其他文件名。无需翻译所有键，缺失的键会回退到英文。文件结构见下方共用示例。

## English

This application-package folder contains built-in language packs. Anas reads them directly and updates them with the application, without copying them into user data:

- `en.json`
- `zh-CN.json`

To add your own language:

1. Copy the bundled English template into `lang/` under application data using a new language file name. Example file names: ja.json, ko.json, fr.json, pt-BR.json.
2. Change `_meta.name` to the display name of your language.
3. Translate the text values. Keep `version: 0`, JSON keys and placeholders such as `{{name}}` unchanged.
4. Save the file as UTF-8 JSON.
5. Restart or reopen Anas so the language list is loaded, then select your language in settings.

Old `en.json` and `zh-CN.json` copies in user data are preserved but ignored; use another file name for a custom language. You do not need to translate every key. Missing keys fall back to English.

## 示例 / Example

```json
{
  "version": 0,
  "_meta": {
    "name": "Example Language",
    "author": "Your name"
  },
  "common": {
    "open": "Open",
    "reload": "Reload"
  }
}
```
