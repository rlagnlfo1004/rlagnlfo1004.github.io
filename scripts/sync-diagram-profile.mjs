#!/usr/bin/env node
// diagram-design 스타일 프로필을 저장소와 홈 라이브러리 사이에서 옮긴다.
//
// 왜 사본이 둘이나 되나
//  - 스킬은 프로필을 `~/.diagram-design/profiles/<slug>.md` 에서만 읽는다. 저장소 안을
//    보지 않는다(플러그인 업데이트가 설치본을 덮어써도 스킨이 살아남게 하려는 규약이다).
//  - 그런데 홈에만 두면 다른 기기에서 클론했을 때 스킨이 없다. 루트의 `.diagram-design`
//    마커는 "looksgood-blog 를 써라"는 포인터일 뿐이라 실물이 같이 오지 않는다.
//  - 그래서 저장소가 원본, 홈은 설치본이다. 이 스크립트가 둘을 오간다.
//
//   npm run diagram:profile          저장소 → 홈 (새 기기에서 한 번)
//   npm run diagram:profile save     홈 → 저장소 (/diagram-design:profile update 뒤에)
//
// 다르면 절대 말없이 덮어쓰지 않는다. 어느 쪽이 최신인지는 사람만 안다.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SLUG = "looksgood-blog";
const repo = join(dirname(dirname(fileURLToPath(import.meta.url))), ".claude", "diagram-design", `${SLUG}.md`);
const home = join(homedir(), ".diagram-design", "profiles", `${SLUG}.md`);

// npm 은 `-- --force` 에서 `--` 를 떼고 넘긴다. 플래그를 먼저 걷어내야
// `--force` 가 하위 명령 자리로 밀려 들어오지 않는다.
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const [cmd = "install", ...rest] = argv.filter((a) => !a.startsWith("-"));
if (!["install", "save"].includes(cmd) || rest.length) {
  console.error(`알 수 없는 명령: ${[cmd, ...rest].join(" ")}\n  install (기본)  저장소 → 홈\n  save            홈 → 저장소\n  --force         다를 때 덮어쓴다`);
  process.exit(2);
}

const [from, to] = cmd === "install" ? [repo, home] : [home, repo];
const label = cmd === "install" ? "저장소 → 홈" : "홈 → 저장소";

if (!existsSync(from)) {
  console.error(`✘ 원본이 없다: ${from}`);
  if (cmd === "save") console.error("  홈에 프로필이 없다면 먼저 `npm run diagram:profile` 로 설치하세요.");
  process.exit(1);
}

const same = existsSync(to) && readFileSync(from, "utf8") === readFileSync(to, "utf8");
if (same) {
  console.log(`· 이미 같다 (${SLUG})\n  ${to}`);
  process.exit(0);
}

if (existsSync(to) && !force) {
  console.error(
    `⚠ 두 사본이 다르다. 어느 쪽이 최신인지 확인하고 방향을 정하세요.\n` +
      `  저장소  ${repo}\n` +
      `  홈      ${home}\n\n` +
      `  차이 보기 : diff "${repo}" "${home}"\n` +
      `  저장소 채택: npm run diagram:profile -- --force\n` +
      `  홈 채택   : npm run diagram:profile save -- --force`,
  );
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`✔ ${label} 복사 (${SLUG})\n  ${to}`);
