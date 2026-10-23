# 工作记录

## 2026-10-17：首版非 GPU 接入

- 直接在 main 落地，未提交/推送/建分支，未打开已有 data/密钥、未调用真实模型、未启动或重启业务服务。
- 新增 protocol 2 严格有界增量 MIME 接收器、原生 multipart 上传、网络空闲超时、同任务整文件 GET、固定 ACK；旧同步文字/图片保持兼容，修复无限等待分支的 FormData 编码并贯通异常取消。
- SQLite 17：明确协议/视频参数、操作/受理/事件/来源/回执持久记录、文件关联和片段版本；旧 BLOB 原样保留。新媒体 fsync/rename/关联后 ACK，业务保存失败可按操作补偿；完整保存/确认/艺术采用独立。
- 演员/场景/定妆改走共用新协议接缝；操作历史提供播放/查看、恢复、同回执核对、人工采用和显式解除防重锁。来源变化保留历史、不覆盖；停止/离页只中止当前传输，不自动新 POST。
- 完成每镜构图、片段镜头顺序/来源版本、六段人工提示词、真实 Picture/Subject 映射、显式 size/frames/fps 视频提交、保存/历史/播放/采用。
- 增加隔离单元/回环 HTTP/VM 交互测试；旧测试只更新已改变的 schema/type/size 契约断言，未删用例。最终执行数字见下次验证记录；不以编译或模拟成功冒充真实 GPU 能力。

### 验证记录

专用副本 `/tmp/ironweave-drama-validation`，Node `/root/.nvm/versions/node/v24.19.0/bin/node`。所有库为 `:memory:` 或 mkdtemp，网络为回环合成服务。未配置解码工具时真实 ffmpeg 合成媒体测试明确跳过；主会话负责隔离补齐工具及 Iron/Node 集成。

### 最终非 GPU 验证结果

- 使用主会话隔离安装的 ffmpeg/ffprobe 7.1.5：`/root/.cache/ironweave-v1-687825ec7cbd/bin/{ffmpeg,ffprobe}`，未改全局 PATH/LD_LIBRARY_PATH。
- 最终测试副本：`/root/.cache/ironweave-v1-687825ec7cbd/drama-validation`；`TMPDIR=/root/.cache/ironweave-v1-687825ec7cbd/drama-tmp`，数据根为副本的 `isolated-data`。
- `node --test`：**411 tests / 411 pass / 0 fail / 0 skipped**。真实 CPU 合成 PNG/MP4 完整解码、错误尺寸/帧数/截断拒绝，并通过本地合成服务执行 MIME→实际解码→fsync/rename→SQLite→ACK。这里的上游仍是回环合成服务，不冒充真实 Iron Server/Node 串联。
- 所有 `src/*.js`、`public/*.js` 的 `node --check` 通过；`git diff --check` 通过。仓库未配置独立 lint/typecheck 脚本。
- main HEAD 仍为 `dbfb7648873c2c0bf7b6fba3dec1dd69ebd3f9bc`，未提交。远端服务未重启，旧业务 data 未访问或迁移。
- 待主会话：真实 Iron Server/Node 非 GPU 串联、浏览器实机交互/代理/断流验收及最终统一审阅；GPU/POWER/真实模型能力不在本次验证结论内。

## 独立 Drama 质量复核（Trellis check）

### 已证实并修复

- 已保存文件恢复不再重复提交 `local_state=saved`，先重验文件再核对同回执；额外保存写入故障不再阻断本可发送的 ACK（D1 S34）。
- rename 后目录 fsync 失败时，恢复必须重新刷盘最终文件及目录再提交 SQLite，不能仅因文件可见就 ACK。发布最初 fsync 失败也关闭句柄，保留残片供同操作恢复。
- 已保存文件损坏、仍在窗口内时仅 GET 同一产物，从新残片重收并原子替换；不 ACK 坏文件、不 POST 新任务。
- 媒体后的 transfer_error 只合并固定回执与期限，不丢 output_begin 技术属性，不信任该事件里的未知媒体属性。完整残片可重新验收、发布并核对 ACK，无需误走 GET。
- ACK 200 必须为未压缩 application/json（允许 UTF-8 charset）；所有成功响应拒绝重复关键协议头，避免 Node 默认忽略重复 Content-Type 后误确认。
- 保存新片段版本时同一 SQLite 事务撤销旧视频当前采用指针和标记；历史媒体及确认记录不删除。
- CPU 实测发现普通 MPEG4/Matroska 会通过原 WebM 检查。现有界解析 8 KiB EBML 头、验证唯一 DocType=webm 及 WebM 编码，再完整解码；真实 VP8 WebM 通过，MKV 冒充与坏头拒绝。

本轮修改范围：`src/{generation-operations,media-files,ironweave-client,video-production}.js`、对应四个 test 文件、README.md、本 work.md。没有更改 public/app 路由或数据库 schema。

### 实际验证

- 独立先复跑实施者基线：411/411，通过、无跳过。
- 新增真实 SQLite 触发器故障、文件/目录 fsync 故障、损坏文件、SQLite 关闭重开、显式释放锁、片段采用版本及真实 WebM/MKV 回归；并扩充既有 ACK HTTP 用例。
- 最终：**421 tests / 421 pass / 0 fail / 0 skipped**，约 5.29 秒。
- 所有 src/*.js、public/*.js 的 `node --check`、远端 `git diff --check` 均通过。仓库没有独立 lint/typecheck 脚本。
- 源码副本：`/root/.cache/ironweave-v1-687825ec7cbd/drama-review-validation`；TMPDIR/TMP/TEMP：同私有根下 `drama-review-tmp`；数据根：副本 `isolated-data`。Node v24.19.0 显式绝对路径，FFMPEG/FFPROBE 使用同私有根 bin 包装器。
- 日志：私有根下 `drama-review-baseline.log`、`drama-review-red.log`、`drama-review-video-red.log`、`drama-review-tests.log`。前两组新增恢复/采用回归先在原实现实际失败，再修复通过。

### 未结案（不因测试全绿而放行）

1. **项目删除 / 交付恢复缺口**：隔离内存库+新合成文件实测，删除含 saved、ACK 未确认媒体的项目后，项目及旧 image 行已删除，但 generation_operations=1、generated_media_links=1、新文件仍存在，原项目操作路由因项目不存在不可访问；删除 API 配置仍返回409。不是普通自动 GC 延期，需主会话决定删除前核对门禁、删除后历史/恢复入口及可恢复文件回收策略。没有扫描旧目录或直接删除用户文件补救；README 已明确此限制。
2. 历史 UI 展示的是保存的来源版本/hash，不是动态计算的“当前有效/已过期”状态；上游来源或旧资源清除后的 adopted 展示也未统一失效。采用动作会重新校验并拒绝旧来源，不能把这一防护等同完整来源状态 UI 已交付。主会话应在浏览器验收中收口，不擅自重做界面契约。
3. 本复核没有替代真实 Iron Server/Node+Drama、浏览器、代理/慢网/长排队和跨进程 kill/restart 验收。SQLite 实际重开及故障注入不等于断电持久性或完整服务重启验收。没有真实模型/GPU/POWER 验证。

### 操作与撤回边界

- main HEAD 仍为 `dbfb7648873c2c0bf7b6fba3dec1dd69ebd3f9bc`；44 个整体工作区改动仍未提交。未建分支/commit/push、未派生代理、未启动默认 server、未读取 .env/既有 data/真实密钥、未做业务库迁移或降级。
- 尚无本轮提交 SHA，不能虚构已可执行的 revert 点。主会话统一审阅并形成真实 main 提交后，使用 `git revert <包含本轮修复的真实提交SHA>` 撤回源码；该操作不做数据库降级或删除媒体。提交前若仅撤回本轮，应对上列局部修复做反向补丁，不能 checkout/reset 整个未提交实现而抹掉实施者代码。

## A/B 业务缺口收口（按主会话明确设计）

本节更新上一轮“未结案”第1/2项：**项目删除和动态来源有效性已经落实并回归通过**；先前发现及数字保留为审阅历史，不再代表当前代码仍缺失该功能。

### A：删除事务与持久清理

- SQLite 增量版本18新增 `media_cleanup(operation_id,project_id,last_error,created_at)`。只对临时库运行16→18/17→18及失败回滚；未打开或升级业务库。
- 项目存在 active 操作、进程内接收/恢复操作、或 delivering 且 ACK 未确认时明确409；release不等于确认/取消。历史与recover入口保持可达，真实既有ACK夹具验证恢复同回执后才允许删除。
- 允许删除时在同一事务登记本项目UUID待办、删除相应generated_media_links/generation_operations及项目。事务失败全部回滚，文件尚未删除；资源/集/季删除仅移除悬空链接，保留项目操作历史/文件。
- 新增 `src/media-cleanup.js` 的 `cleanupPendingMedia(db,{directory,projectId,limit})`：只unlink待办UUID的.part/.media，同步目录后才移除待办，ENOENT幂等；不扫描目录、不递归删除、不迁移旧BLOB。失败保留记录和脱敏错误，数据库重开可重试。
- app提交后每次最多处理25项；server启动接入最多100项重试；函数默认50、允许1–100。剩余任务需继续显式调用/后续启动重试，不冒充后台全目录GC。HTTP和浏览器明确提示“项目已删除，媒体清理待重试”，不把清理失败说成项目删除失败。
- 防止两个相关竞态：已release的操作恢复中也禁止删除项目；异步准备参考文件之后如果项目已删除，生成操作事务拒绝插入，不遗留孤儿记录或发送新POST。

### B：动态来源状态与采用门禁

- 新增只读 `src/generation-source.js::sourceStatus(db,row)`，复用resourceRevision/readResourceReference、lookInputs、shotSource/clipSource与同一源摘要规则，返回current/expired/deleted及中文原因。
- listOperations附加sourceStatus，历史页单独显示来源有效性；已采用且来源无效显示“曾采用，当前已失效”，不冒充当前采用。片段页同样标记旧采用失效。
- 来源无效时禁用未采用媒体的采用按钮；已采用结果重复调用也先在事务中核实当前来源，再决定幂等返回。媒体播放、历史及同任务交付恢复不依赖来源有效性。
- 资源/季/集删除提示已区分旧BLOB删除与新文件历史保留；不隐式替换或删除媒体。片段自身版本编辑撤销旧采用指针的上一轮回归继续通过。

### 验证结果

- A回归先在原实现失败：ACK未知删除实际200（应409）、缺少media_cleanup；日志 `drama-review-lifecycle-red.log`。
- 最终 **444 tests / 444 pass / 0 fail / 0 skipped**，约5.39秒；相较上一轮421项新增23项。日志：私有根 `drama-review-ab-tests.log`。
- 覆盖删除拒绝/recover可达/真实同回执确认后删除、事务回滚、文件删除失败、清理完成写入失败、SQLite重开重试、有界批次、非法UUID、其他项目/未登记文件/旧BLOB不受影响、配置无悬空操作锁、16/17→18迁移与回滚、五类来源变更及已采用也拒绝、资源/集/季删除后的失效历史、只读查询和浏览器删除消息。
- 继续使用 `/root/.cache/ironweave-v1-687825ec7cbd/drama-review-validation` 源码副本；TMPDIR/TMP/TEMP设为同私有根drama-review-tmp，数据根isolated-data；显式Node v24.19.0及真实ffmpeg/ffprobe包装器，合成媒体完整解码测试未跳过。
- 全部src/*.js/public/*.js的node --check、git diff --check通过，无独立lint/typecheck脚本。
- server启动清理接缝已静态复核且其同一helper已真实故障测试；按授权边界没有启动默认server或重启业务服务。主会话须同步最终源码后继续真实Iron/Drama及浏览器联调，不以本轮HTTP/VM测试替代浏览器实机。

### 变更与撤回

- 新增4文件：src/media-cleanup.js、src/generation-source.js、test/media-lifecycle.test.js、test/generation-source.test.js。
- 接通app/server/deletion/database；复用来源状态修改generation-operations/media-adoption/video-production/render-generation；更新角色/场景/季集/定妆删除文案、public/delete.js及相应测试。旧迁移用例只将“成功升级最终版本”从17改18，原失败回滚断言不改。README已同步实际契约。
- main HEAD仍为dbfb7648873c2c0bf7b6fba3dec1dd69ebd3f9bc，整体55个工作区改动未提交。未建分支/提交/push/派生代理；没有读取data/.env/真实密钥，没有部署、模型调用或业务库降级。
- 撤回接口仍须由主会话形成真实main提交后执行 `git revert <真实SHA>`；不得凭空填写撤回提交。源码撤回不等于媒体或schema降级，须保留版本18待办/媒体备份；提交前只能反向本轮局部补丁，不能reset/checkout整套未提交实现。


2026-10-17 23:25 +0300---包内测试不能代替真实Iron/Node及业务浏览器联调---主会话重新同步最终源码到私有副本，444/444测试与全部JS语法检查通过；真实Iron Server+Node+PG/Redis/MinIO经临时回环SSH与实际Drama接通三入口、丢ACK补同回执及截断GET恢复；真实Chromium操作演员/场景/定妆/镜头构图/两镜六段视频、保存后采用、H264实际播放、Drama进程重启、旧来源重复采用拒绝以及项目删除后文件和持久待办清空，均通过。两个测试脚本初次失败分别是精确label定位及重复close数据库，已修正测试脚本后全量复跑；没有改弱产品断言---本仓55个修改文件即当前src/public/test/README/work，跨仓验证脚本在IronWeave/scripts/dev，源码未另加测试入口；按既有授权直接main本地提交，不push。未读取/迁移既有data/.env/密钥、未重启默认业务服务、未调用真实模型/GPU。撤回使用本次真实commit的git revert；Schema18/已保存媒体独立于源码回滚，不擅自降级或删除用户数据。

2026-10-18 图片实际尺寸---用户要求演员／场景／定妆的实际输出尺寸来自前端本次生成参数，旧比例表固定像素不能满足，API testSize也不能替代---三个真实生成表单增加空初值可编辑必填size，共用requestedImageSize在联网与操作登记前校验单值／规范正整数／安全整数／64,000,000像素／业务比例；同值写入Iron请求与expected，protocol2缺size拒绝，legacy仅完全缺字段保留旧兼容；不改提示词、参考顺序、保存后ACK或人工采用。独立审阅未发现确定缺陷，主会话核实11文件与测试副本hash一致并实际复跑远端独占副本464/464通过，0跳过---修改src/resource-images.js、looks.js、render-characters.js、render-scene-images.js、render-production-resources.js、public/character-images.js、production-resources.js及4份test文件（含新增image-output-size.test.js），记录work.md。未读取或迁移原data/.env，未重启原业务服务，未运行GPU；真实模型页面另行验收，不以测试冒充。按既有授权main本地commit，不push；撤回使用对应git revert，数据库和媒体不随源码删除。

2026-10-23 17:01 +0300---用户明确不要legacy并批准“实现你的设计”；旧图片JSON/Base64/URL生成仍可执行，设置测试只单图／无素材视频，明确拒绝与未知提交混淆、本地快时钟错误阻断恢复---媒体三类型按用途统一Weave，删除旧同步图片解析与下载、协议选择和遮罩生成入口；旧配置／历史BLOB／文件／回执保留且不自动改写，文字聊天独立。设置测试支持有序多图和显式视频参数，只有该测试路由multipart上限65MiB；本次size始终必填。完整确定拒绝本地rejected并解除防重，503／截断仍未知保锁；ACK拒绝与未知分别说明，已有文件保留，GET期限由Weave裁决。真实浏览器发现视频参数数字转义500，独立审阅复现无素材长中文被urlencoded限额误413；分别以String转义和视频表单统一FormData最小修复，保持原安全限额，均补真实红绿。最终本机Node24.18和LinuxNode24.19隔离源码各540/540通过、0跳过；101份JS语法与diff检查通过。真实Chromium／Drama／回环合成上游／CPU解码通过文生图、双参考、五参考视频及无参考12000汉字视频，4次保存后ACK、一次独立聊天和WebM实际播放，零浏览器／上游错误；不是GPU重新验收---修改README、public/{settings,character-images}.js、src/{settings,render-settings,app,generation-operations,ironweave-client,model-client,images,resource-images,looks,render-generation,render-characters,render-scene-images,render-production-resources}.js、对应test文件并新增test/helpers/weave-images.js、settings-weave.test.js、weave-pages.test.js，记录work.md。基线main@5119879，按已授权形成单一可撤回源码检查点；查询git log -1 --format=%h -- public/settings.js，再经确认git revert对应SHA。未安装依赖、连接AC922、调用真实模型/GPU、打开真实data/.env、迁移业务库或启停原服务；正式仓库仅同步经检查的源码，不push、不amend，源码回滚不删除媒体和回执。
