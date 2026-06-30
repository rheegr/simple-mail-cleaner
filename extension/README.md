# InboxPurge (Chrome extension)

Gmail 안에서 이메일을 선택하면 그 발신자 전체에 대해 Super Unsubscribe / Super Delete를 실행하는 크롬 확장.

## 동작
- mail.google.com에 content script 주입.
- Gmail 리스트에서 메일을 체크하면 화면 하단에 액션바가 뜸.
- "Super Unsubscribe" 또는 "Super Delete" 클릭 → 확인 모달(기간 선택, 영구삭제 옵션) → 실행.
- 액션은 선택한 메일이 아니라 그 메일의 **발신자 전체**에 적용됨.
- 실제 Gmail API 호출(목록/삭제/수신거부)은 background service worker가 담당.

## 설치 (개발자 모드, unpacked)
1. 크롬에서 `chrome://extensions` 열기.
2. 우측 상단 "개발자 모드" 켜기.
3. "압축해제된 확장 프로그램을 로드합니다" → 이 폴더(`C:\dev\inbox-purge\extension`) 선택.
4. Gmail(mail.google.com) 열고 새로고침.
5. 메일 체크 → 하단 액션바 → 버튼 클릭. 첫 실행 시 구글 OAuth 동의 화면이 한 번 뜸(rheegr@gmail.com).

## 구성
- `manifest.json` — MV3. `key`로 확장 ID 고정(`jmhemkgmbplfkjbklimmkogkkibeiehl`), `oauth2`로 Chrome Extension OAuth client 연결.
- `background.js` — chrome.identity 토큰, Gmail REST 호출.
- `content.js` — 선택 감지, 액션바/모달/토스트 주입.
- `content.css` — 주입 UI 스타일(`ipg-` prefix).

## 주의
- `.key.pem`은 확장 ID 서명용 개인키. 커밋/공유 금지(.gitignore 처리).
- Gmail 비공개 DOM 구조(`tr.zA`, `span[email]`)에 의존하므로 Gmail UI 변경 시 `content.js`의 선택 감지 로직 점검 필요.
- OAuth 앱이 testing 상태라 test user(rheegr@gmail.com)만 사용 가능.
