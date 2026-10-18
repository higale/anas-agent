# Plugin examples

[简体中文](README.md)

**Settings > Plugins > Install plugin** opens `examples/plugins/` under application data by default. Select one of the ZIP files below directly. Each ZIP is a complete independent plugin with `PLUGIN.json` at its root; manual extraction is unnecessary. Startup and backup restore refresh the ZIP files and this guide. Examples are not registered or enabled automatically, and refreshing them does not overwrite installed copies.

- `notepad.zip`: a Chinese/English notepad without a backend, demonstrating bundled SVG icons, shared save actions, language resources, host language selection, data persistence, and preservation of unsaved edits.
- `text-tools.zip`: tools without a page, demonstrating text, Base64 images, cancellation, backend reuse, and general settings that can be edited without starting the backend.
- `writing-helper.zip`: declarative skills and static prompts without a backend.
- `backend-demo.zip`: an English-only optional Node backend. The first click on **Call** starts it; try successful calls, errors, and restarting after stopping.

The repository retains source directories with the same names under `data/examples/plugins/`; the examples require no npm dependencies of their own. `npm run dev` and `npm run build` generate `out/examples/` automatically; `npm run build:examples` also runs this step separately. Generated ZIPs are not committed to Git. To study or modify an example, use the repository source or extract a ZIP, then install via `PLUGIN.json` or by dropping the directory.

The notepad declares `"lang": "lang"` in its manifest, reads `lang/en.json` and `lang/zh-CN.json` through `anas.getLanguageResources()`, and obtains the host language through `anas.getInfo()`. `plugin.name` and `plugin.description` also supply the host menu, settings, and default window title. The page refreshes its language, theme, and font size on focus and every five seconds while visible, preserving draft and save state. Missing or blank translations fall back to English.

The notepad does not repeat its title inside the page. The sidebar's save button is right-aligned at the bottom; separate windows hide that button and use the title-bar save action, while save status remains at the bottom of the page. Both actions share `assets/save.svg` and the same save handler. The toolbar registers `icon: 'assets/save.svg'`; the page uses the same icon through `<img>`, with light and dark colors defined by the icon itself.

To keep the example simple and free of build steps, `app.js` only demonstrates static text lookup. For interpolation or plurals, use the plugin's own i18next instance. To add a language, copy and translate the English JSON; the host must also support that language. See the [localization API](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md#多语言).

Installation copies the package. After editing the source, reinstall the same plugin ID and confirm replacement. Existing data is retained unless deletion is explicitly selected. See the [plugin documentation](https://github.com/higale/anas-agent/blob/main/docs/PLUGINS.md) for the API, manifest, and lifecycle.
