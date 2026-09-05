# Anna for Codex

[English installation](#english-installation) · [中文安装说明](#中文安装说明)

<p align="center">
  <img src="../docs/public/assets/anna-pet/anna.png" width="192" height="208" alt="Anna, the iris-haired Codex companion" />
  <img src="../docs/public/assets/anna-pet/waving.gif" width="192" height="208" alt="Anna waving" />
</p>

## English installation

1. [Download the pet ZIP](https://github.com/Foxtailsss-Andy/Anna-Agent/releases/download/anna-pet-v1.0.0/anna-codex-pet-v1.0.0.zip) and extract it.
2. Copy the entire `anna-iris` folder into `~/.codex/pets/`. If you set `CODEX_HOME`, use its `pets/` directory instead. Keep `pet.json` and `spritesheet.webp` together. If you already have an `anna-iris` folder, save a copy before replacing it.
3. In the desktop app, open **Settings → Pets**, select **Refresh**, and choose **Anna**. Enter `/pet` to show the floating companion.

The installed layout is:

```text
~/.codex/pets/
└── anna-iris/
    ├── pet.json
    └── spritesheet.webp
```

For Windows, the default directory is `%USERPROFILE%\.codex\pets\`; a custom `CODEX_HOME` takes precedence. This package requires a desktop version that supports custom v2 pets. If Anna does not appear after refreshing, check the folder layout and update the app. See the [official pet guide](https://learn.chatgpt.com/docs/pets) for the current UI.

This is a visual companion package containing a manifest and artwork, with no executable code or credentials. You can use it without installing the Anna application.

## 中文安装说明

1. [下载宠物 ZIP](https://github.com/Foxtailsss-Andy/Anna-Agent/releases/download/anna-pet-v1.0.0/anna-codex-pet-v1.0.0.zip)，然后解压。
2. 将整个 `anna-iris` 文件夹放入 `~/.codex/pets/`。如果设置了 `CODEX_HOME`，则放入该目录下的 `pets/`。保留 `pet.json` 和 `spritesheet.webp` 在同一文件夹内；如果已有同名宠物，替换前先保留副本。
3. 在桌面应用中打开 **设置 → Pets（宠物）**，点击 **Refresh（刷新）**，选择 **Anna**。输入 `/pet` 即可唤醒悬浮小宠物。

Windows 默认目录为 `%USERPROFILE%\.codex\pets\`，自定义 `CODEX_HOME` 时以该目录为准。需要支持自定义 v2 宠物的桌面版本；刷新后未出现时，请检查目录层级并更新应用。当前界面说明可参考 [官方宠物指南](https://learn.chatgpt.com/docs/pets)。

这是仅含配置与形象素材的视觉陪伴包，不含可执行代码或凭据，无需安装 Anna 应用即可使用。

## Package details / 素材说明

- Pet ID: `anna-iris`; display name / 显示名称: `Anna`.
- Format / 格式: `spriteVersionNumber: 2`, transparent WebP / 透明 WebP, `1536 × 2288`, `8 × 11` cells / 网格.
- Animation states / 动作: idle / 待机, running-right / 向右移动, running-left / 向左移动, waving / 挥手, jumping / 跳跃, failed / 失败, waiting / 等待, running / 工作中, review / 审阅; plus 16 look directions / 另含 16 个视线方向.
- Artwork / 素材: AI-generated for the Anna project; the still image is captured from the packaged sprite. / 为 Anna 项目生成的 AI 形象；静态图截取自发布的精灵素材。
- Validation / 验证: v2 atlas structure, transparency, and required cells checked on September 5, 2026. / 已于 2026 年 9 月 5 日检查 v2 图集结构、透明通道和必需帧。Some intermediate gaze directions are subtle. / 部分中间视线方向的差异较细微。
- License / 许可: [MIT](../LICENSE), consistent with the Anna repository / 与 Anna 仓库一致.

This download is a pet asset release. Anna's application update is still in development. / 此次下载为宠物素材发布，Anna 应用的新更新仍在开发中。
