## Anas v5.2.27

### 中文

- PDF、DOCX 和 PPTX 现在由“文件写”中的内置工具 `document_to_markdown` 离线转为 Markdown，电脑无需安装 Python。源文件路径和保存路径均为必填项。图片保存在 Markdown 旁的同名 `_images` 目录中。
- PDF 图片跟随各页正文，保留旋转方向和透明区域。Windows 上可将 Word 和 PowerPoint 中的普通 EMF、WMF 图片显示为 PNG。PowerPoint 手写墨迹及其预览图仍会跳过。
- 安装包已移除内置 Python，设置中也移除了对应开关。`.py` 自定义工具使用系统 Python 3。原来使用 `{{bundled_python}}` 的命令请改为脚本路径或自己的解释器绝对路径。
- 项目选择菜单中的创建入口已更正为“新建项目”。从源码安装时，项目使用 npm 官方源下载锁定依赖，修复了使用镜像时出现的缺包和 npm 12 拒绝下载问题。

### English

- The built-in `document_to_markdown` tool under File Write now converts PDF, DOCX and PPTX files offline without a Python installation. Both the source and output paths are required. Images are saved beside the Markdown file in `<output stem>_images/`.
- PDF images follow their page text and retain their rotation and transparency. On Windows, supported EMF and WMF pictures in Word and PowerPoint appear inline as PNGs. PowerPoint handwriting and its previews are still skipped.
- Anas no longer ships Python or its settings switch. Custom `.py` tools use system Python 3. Change any command that uses `{{bundled_python}}` to the script path or the absolute path of your interpreter.
- The project picker now labels its creation action “New project”. Source installs use the official npm registry for locked dependencies, fixing missing mirror packages and npm 12 download refusals.
