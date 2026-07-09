# DEV Anywhere Documentation

This directory contains public documentation for operating and releasing DEV Anywhere.

## Main References

| Document                                               | Purpose                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- |
| [`../README.md`](../README.md)                         | Project overview and quick start.                       |
| [`../README.zh-CN.md`](../README.zh-CN.md)             | Simplified Chinese project overview.                    |
| [`DEPLOYMENT.md`](DEPLOYMENT.md)                       | Hosted relay/web deployment and operations guide.       |
| [`PWA.md`](PWA.md)                                     | iPhone, iPad, and desktop PWA installation guide.       |
| [`RELEASE-0.5-READINESS.md`](RELEASE-0.5-READINESS.md) | 0.5 public-stable release readiness gates.              |
| [`../PUBLISHING.md`](../PUBLISHING.md)                 | Versioning, npm, Docker, and VPS release process.       |
| [`SCRIPTS.md`](SCRIPTS.md)                             | Development, deployment, and verification script guide. |
| [`assets/`](assets/)                                   | Public README images and logo assets.                   |

## Known Issues

记录已知但根因未定的问题 + 下次复现时的取数 playbook, 见 [`known-issues/`](known-issues/):

| Document                                                  | Status                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`pty-blank-render.md`](known-issues/pty-blank-render.md) | 移动端 PTY viewport 偶发空白带, 已修若干候选成因, 待真机数据回归。      |
| [`pty-garbling.md`](known-issues/pty-garbling.md)         | PTY 渲染偶发乱码 / 叠字 / U+FFFD, 已修若干 atlas 成因, 待真机数据回归。 |
