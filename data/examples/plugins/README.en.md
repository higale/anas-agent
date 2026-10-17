# Plugin examples

[简体中文](README.md)

This directory ships with the application resources. Startup and backup restore copy its examples to `examples/plugins/` under application data. **Settings > Plugins > Install plugin** opens that directory by default. Select `PLUGIN.json` from one of the subdirectories below or a packaged plugin ZIP. Selecting a manifest copies the entire plugin directory into the user installation directory, `plugins/`. These examples require no npm dependencies and are not registered or enabled automatically; refreshing examples does not overwrite installed copies.

- `notepad/`: a Chinese/English notepad without a backend, demonstrating bundled SVG icons, shared save actions, language resources, host language selection, data persistence, and preservation of unsaved edits.
- `text-tools/`: tools without a page, demonstrating text, Base64 images, cancellation, backend reuse, and general settings that can be edited without starting the backend.
- `writing-helper/`: declarative skills and static prompts without a backend.
- `backend-demo/`: an English-only optional Node backend. The first click on **Call** starts it; try successful calls, errors, and restarting after stopping.

The notepad declares `"lang": "lang"` in its manifest, reads `lang/en.json` and `lang/zh-CN.json` through `anas.getLanguageResources()`, and obtains the host language through `anas.getInfo()`. `plugin.name` and `plugin.description` also supply the host menu, settings, and default window title. The page refreshes its language, theme, and font size on focus and every five seconds while visible, preserving draft and save state. Missing or blank translations fall back to English.

The page's save button and the separate window's toolbar share `assets/save.svg` and the same save handler. The toolbar registers `icon: 'assets/save.svg'`; the page uses the same icon as a CSS mask, inheriting the current text color.

To keep the example simple and free of build steps, `app.js` only demonstrates static text lookup. For interpolation or plurals, use the plugin's own i18next instance. To add a language, copy and translate the English JSON; the host must also support that language. See the [localization API](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md#多语言).

Installation copies the package. After editing the source, reinstall the same plugin ID and confirm replacement. Existing data is retained unless deletion is explicitly selected. See the [plugin documentation](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md) for the API, manifest, and lifecycle.
