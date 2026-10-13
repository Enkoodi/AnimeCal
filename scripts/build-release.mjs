#!/usr/bin/env node
/**
 * 发布构建 —— 产物「去本机痕迹」。
 *
 * 用法：npm run build:release   （等价于 npx tauri build --no-bundle，但会重写编译期路径）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * Rust 会把源码与依赖的**绝对路径**当字符串常量写进二进制（panic 位置、file!()、
 * #[track_caller]、assert 消息）。它们躺在数据段里，不是调试信息，所以 `strip` 一个都删不掉。
 * 唯一手段是 rustc 的 --remap-path-prefix：编译时把构建机的路径前缀替换成中性路径。
 *
 * ── 为什么用脚本而不是 .cargo/config.toml ────────────────────
 * config.toml 是**入库的**，而重映射的前缀天然包含构建机的用户名，等于把用户名写进仓库。
 * 本脚本改为运行时推导，仓库里不留任何用户名 / 镜像源 / 绝对路径：
 *   - 用户目录：CARGO_HOME 的上一级 → USERPROFILE → os.homedir()
 *   - registry 目录名（如 mirrors.ustc.edu.cn-<hash>）不写死，直接扫 $CARGO_HOME/registry/src/
 *
 * ── 两个坑（都实测过）────────────────────────────────────────
 * 1. rustc 的 --remap-path-prefix **不是「最长匹配优先」，而是最后一条匹配的生效**（后覆盖前）。
 *    所以笼统的短前缀要排在前面当兜底，精确的长前缀必须排在最后。写反了会得到
 *    /home/user\.cargo\registry\src\mirrors.ustc... 这种半成品（用户名没了，镜像源还在）。
 * 2. 用 CARGO_ENCODED_RUSTFLAGS（\x1f 分隔）而不是 RUSTFLAGS：后者按**空白分词**，
 *    用户名里只要有空格，一个路径就会被拆成两个 flag。
 * ────────────────────────────────────────────────────────────
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const home = process.env.USERPROFILE || os.homedir() || process.env.HOME || "";
const cargoHome = process.env.CARGO_HOME || (home ? path.join(home, ".cargo") : "");

// 顺序敏感：短的在前、长的在后（后者覆盖前者）。
/** @type {{from: string, to: string, kind: string}[]} */
const rules = [];
if (home) rules.push({ from: home, to: "/home/user", kind: "兜底：用户目录" });
if (cargoHome) rules.push({ from: cargoHome, to: "/cargo", kind: "CARGO_HOME" });

// registry 的实际目录名与镜像源绑定（mirrors.ustc.edu.cn-<hash> / index.crates.io-<hash> …），
// 不写死，运行时扫出来 —— 换镜像、换机器都不用改脚本。
const srcRoot = cargoHome ? path.join(cargoHome, "registry", "src") : "";
if (srcRoot && existsSync(srcRoot)) {
  for (const name of readdirSync(srcRoot)) {
    if (!name || name.startsWith(".")) continue;
    rules.push({
      from: path.join(srcRoot, name),
      to: "/cargo/registry",
      kind: "依赖源码（扫描所得）",
    });
  }
}

const remapFlags = rules.map((r) => `--remap-path-prefix=${r.from}=${r.to}`);

// 尊重用户已有的 RUSTFLAGS，原样并入；我们的重映射排在其后。
const inherited = (process.env.RUSTFLAGS || "").split(/\s+/).filter(Boolean);
const encoded = [...inherited, ...remapFlags].join("\u001f");

console.log("[build:release] 编译期路径重写（rustc 规则：最后一条匹配的生效）");
if (rules.length === 0) {
  console.warn("  ⚠️ 推导不出用户目录 / CARGO_HOME，本次不会重写任何路径。");
}
for (const r of rules) console.log(`  ${r.from}\n    -> ${r.to}   [${r.kind}]`);
if (inherited.length) console.log(`  注：已沿用你环境里已有的 RUSTFLAGS（${inherited.length} 项）。`);

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const passthrough = argv.filter((a) => a !== "--dry-run").join(" ").trim();
const cmd = `npx tauri build --no-bundle ${passthrough}`.trim();

if (dryRun) {
  console.log("[build:release] --dry-run：仅打印将执行的内容，不构建。");
  console.log(`[build:release] 后续命令：${cmd}`);
  process.exit(0);
}

console.log(`\n[build:release] ${cmd}\n`);

const result = spawnSync(cmd, {
  cwd: projectRoot,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: encoded },
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
