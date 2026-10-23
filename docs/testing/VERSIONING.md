# 日期版本命名 / Calendar versions

Nightscout for Cloudflare 对外使用 `YYYYMMDD` 日期版本，测试版加 `-beta`：

| 位置 | 当前测试版示例 |
| --- | --- |
| 界面、文档及 `package.json.nscfVersion` | `20261023-beta` |
| 测试分支 | `20261023-beta` |
| npm 的 `package.json.version` | `2026.10.23-beta` |
| `package-lock.json` 的两个根版本 | `2026.10.23-beta` |

npm 字段保留合法 SemVer 结构，三个数字依次表示年、月、日，不再表示主版本、次版本和补丁级别。月份和日期不补零，例如 `2026.1.2-beta`；对外标签仍补零为 `20260102-beta`。构建器校验两字段的日期、测试标记及真实日历日期一致，不允许用任意标签掩盖包版本。历史版本没有 `nscfVersion` 时，仍显示原 `version`。

日期形式保留既有测试分支保护：带 `-beta` 的源码构建不会自动从稳定主线替换自身。旧版本、旧包和已有发布标签保留其原名称。

建议正式版按**实际正式发布日期**命名，而非沿用测试开始日。例如 `20261022-beta` 测试三天后在 10 月 25 日正式发布，对外为 `20261025`，npm 为 `2026.10.25`，正式 Git 标签为 `v20261025`；原测试分支仍保留。此正式版命名规则待维护者确认，当前新增测试版使用 `20261023-beta`。

正式标签一旦发布便固定指向对应提交，不移动或覆盖。同一天若还需另一正式版本，应先另定版本标识，不复用既有标签。正式发布和生产部署以维护者明确指令为准；本轮准备测试分支。

上游 Nightscout `15.0.8`、API 协议版本及兼容响应独立维护，不随 NSCF 日期版本改写。

NSCF uses `YYYYMMDD[-beta]` publicly and calendar SemVer `YYYY.M.D[-beta]` in npm metadata. `nscfVersion` must match the same real date and beta state. The proposed formal-release rule uses the actual release day: a `20261022-beta` tested until October 25 becomes `20261025`, with immutable tag `v20261025` and npm version `2026.10.25`. This proposal awaits maintainer confirmation. This round prepares the testing branch; formal release and production deployment follow explicit maintainer instructions. Upstream Nightscout/API versions remain separate.
