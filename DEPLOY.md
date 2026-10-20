# Deploying / 部署指南

How this project gets to production, and what to do when it goes wrong.
项目如何上线，以及出错时怎么办。

---

## English

### The pipeline

```
push to main ──▶ ci.yml ──(all green)──▶ deploy.yml ──ssh──▶ scripts/deploy.sh (on the host)
```

- **ci.yml** runs the suite on both database drivers (PGlite and node-postgres) plus a smoke run. Nothing deploys unless it is green.
- **deploy.yml** fires only for a successful CI run of the repository's own `main`, and deploys *the exact commit CI tested* — not "main as of now", which could have moved under the tests. It can also be run by hand (`Actions → Deploy → Run workflow`) with any ref, which is how a rollback is done.
- **scripts/deploy.sh** is the single deployment command on the host. It is safe to re-run after any failure: migrations are additive and `compose up` only recreates what changed.

What `deploy.sh` does, in order: take a deploy lock (a second concurrent deploy is refused), fetch and check out the target commit, `docker compose build`, bring the stack up (compose itself runs `migrate` to completion, provisions the runtime role, then starts app and worker), poll `/api/health` until it answers, and prune old images. If health never comes up, it prints the app's last 50 log lines and **exits non-zero** — a deploy that cannot answer the health endpoint is reported as failed, not as successful.

### One-time host setup

1. Clone the repository where it should live, e.g. `/opt/rgm`:
   ```bash
   git clone git@github.com:cache51/rgm-project-manager.git /opt/rgm
   ```
2. Create `.env` beside `docker-compose.yml` (see README, *Configuration*). It must exist before the first deploy; `deploy.sh` refuses without it.
3. Bring the stack up once by hand: `docker compose up -d`.
4. Create a deploy user (or reuse one) whose `authorized_keys` holds the deploy key, and which can run `docker` and `git` in the checkout without a password prompt.
5. Sanity-check from your laptop: `ssh deploy@host "cd /opt/rgm && ./scripts/deploy.sh"` should print `deployed: …`.

### GitHub configuration

Settings → Secrets and variables → Actions:

| Name | Kind | Meaning |
| --- | --- | --- |
| `DEPLOY_HOST` | secret | host name or address of the deployment host |
| `DEPLOY_USER` | secret | ssh user for the deploy |
| `DEPLOY_SSH_KEY` | secret | private key whose public half is in `authorized_keys` |
| `DEPLOY_PATH` | variable | checkout path on the host (default `/opt/rgm`) |
| `DEPLOY_URL` | variable | public base URL to health-check after the swap (optional) |

The first workflow run needs these to exist; until then pushes deploy nothing (the job fails at "Set up ssh" with a clear message).

### Everyday use

- **Ship:** push to `main`, or merge a PR. CI proves it, deploy ships it, and the deploy run prints the health answer.
- **Watch:** `Actions` tab — the `deploy` run, or `ssh host "cd /opt/rgm && docker compose ps"` (app must be `healthy`).
- **Roll back:** Actions → Deploy → Run workflow, with the ref of the last good commit:
  ```bash
  # or from the host directly
  DEPLOY_REF=<good-sha> ./scripts/deploy.sh
  ```
  Migrations are **additive**, so an older image runs against a newer schema. If a release ever ships a migration that is not compatible with the previous code, roll back the schema too with `scripts/recover.sh` from a pre-deploy dump (README, *Database recovery*) — do not roll back the app alone.

### If a deploy fails

- `no .env` — someone recreated the checkout without configuration.
- `another deploy is already running` — a stuck deploy holds `deploy.lock`; check `docker compose ps` and the failed run's logs, then re-run.
- `app never passed /api/health` — the logs printed by the script say why (bad `.env`, migration error, port taken). The old containers stay up until compose swaps them, and the health gate means you will always see the failure rather than a silently broken site.

---

## 简体中文

### 发布流水线

```
推送到 main ──▶ ci.yml ──(全绿)──▶ deploy.yml ──ssh──▶ scripts/deploy.sh（在部署机上执行）
```

- **ci.yml**：在两种数据库驱动（PGlite 与 node-postgres）上跑全部测试，外加冒烟测试。不绿不发。
- **deploy.yml**：仅在「本仓库自己的 main 分支、CI 全绿」时触发，并且部署的正是 *CI 验证过的那个 commit*，而不是「此刻的 main」（测试期间 main 可能已经前移）。也可以手动运行（Actions → deploy → Run workflow）并指定任意 ref —— 回滚就是这么做的。
- **scripts/deploy.sh**：部署机上唯一的部署命令。失败后可直接重跑：迁移是增量式的，`compose up` 只会重建发生变化的容器。

`deploy.sh` 按顺序做这些事：拿到部署锁（并发部署会被拒绝而不是交叉执行）、拉取并检出目标 commit、`docker compose build`、启动整套服务（compose 会先跑完 `migrate`、配置运行角色，再启动 app 与 worker）、轮询 `/api/health` 直到应答，最后清理旧镜像。若健康检查始终不过，脚本会打印 app 最近 50 行日志并**以失败退出**——过不了健康检查的部署会被报告为失败，绝不会谎报成功。

### 部署机一次性准备

1. 把仓库克隆到固定位置，如 `/opt/rgm`。
2. 在 `docker-compose.yml` 旁创建 `.env`（见 README「Configuration」）。首次部署前必须存在，否则 `deploy.sh` 拒绝执行。
3. 手动完整启动一次：`docker compose up -d`。
4. 建立部署用户（或复用现有用户），其 `authorized_keys` 放入部署公钥，且无需密码即可在检出目录执行 `docker` 与 `git`。
5. 本地验证：`ssh deploy@host "cd /opt/rgm && ./scripts/deploy.sh"` 应输出 `deployed: …`。

### GitHub 配置

Settings → Secrets and variables → Actions：

| 名称 | 类型 | 含义 |
| --- | --- | --- |
| `DEPLOY_HOST` | secret | 部署机地址 |
| `DEPLOY_USER` | secret | ssh 用户名 |
| `DEPLOY_SSH_KEY` | secret | 私钥（公钥放进 `authorized_keys`） |
| `DEPLOY_PATH` | variable | 部署机上的仓库路径（默认 `/opt/rgm`） |
| `DEPLOY_URL` | variable | 部署后做外部健康检查的公网地址（可选） |

首次运行工作流前这些必须先配好，否则任务会在 “Set up ssh” 一步明确失败。

### 日常操作

- **上线**：推送到 `main`（或合并 PR）。CI 验证、deploy 上线，运行日志里会打印健康检查应答。
- **查看**：Actions 页的 `deploy` 运行记录；或 `ssh host "cd /opt/rgm && docker compose ps"`（app 必须是 `healthy`）。
- **回滚**：Actions → Deploy → Run workflow，填上一个好的 commit ref；或在部署机上：
  ```bash
  DEPLOY_REF=<好的sha> ./scripts/deploy.sh
  ```
  迁移是**只增不改**的，旧镜像可以跑在新 schema 上。但如果某次发布的迁移与上一版代码不兼容，请用发布前的备份通过 `scripts/recover.sh` 连同数据库一起回滚（README「Database recovery」）——不要只回滚应用。

### 部署失败排查

- `no .env`：检出目录被重建但没带配置。
- `another deploy is already running`：有卡住的部署持有 `deploy.lock`；先看 `docker compose ps` 与失败日志，再重跑。
- `app never passed /api/health`：脚本打印的日志会说明原因（`.env` 有误、迁移报错、端口被占）。旧容器在 compose 换血前仍在服务；健康检查闸门保证你一定能看到失败，而不会出现「部署成功但站点坏了」的静默事故。
