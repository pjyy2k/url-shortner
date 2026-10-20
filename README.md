# URL Shortner

Cloudflare Workers + KV 기반 개인용 URL 단축 서비스입니다.
**관리자는 비밀번호로 로그인**, 외부 프로그램은 별도로 발급한 **API 키**를 사용합니다.
단축 링크는 누구나 열 수 있습니다. 서비스 도메인은 `go.hellojyp.com`입니다.

## 기능

- 한국어 관리자 화면, 모바일 대응
- 비밀번호 로그인, 최대 7일 로그인 유지(서명된 HttpOnly·Secure·SameSite=Strict 쿠키)
- 관리 화면에서 현재 비밀번호 확인 후 새 비밀번호로 변경
- 변경한 비밀번호는 랜덤 salt와 PBKDF2-SHA256 100,000회 해시로 KV에 저장
- API 키 이름 지정·발급·목록·폐기: 원문은 발급할 때 한 번만 표시
- API 키로 링크 생성·조회·삭제 가능, 비밀번호 변경·키 관리 불가
- 무작위 16자리 단축 코드, 선택적 만료일, 링크 복사·검색·삭제
- Workers 네이티브 로그인 요청 제한(IP별 60초당 10회, 지역 단위 근사 제한)
- 원래 주소를 서버에서 fetch하지 않고 302 리다이렉트, 런타임 외부 API 호출 없음

## 처음 시작하기

Node.js **22.18 이상**, Cloudflare 계정이 필요합니다.

```bash
git clone https://github.com/pjyy2k/url-shortner.git
cd url-shortner
npm ci
npx wrangler login
```

이 저장소의 `wrangler.jsonc`에는 KV Namespace ID와 커스텀 도메인이 이미 입력되어 있습니다.
다른 계정으로 설치한다면 `npx wrangler kv namespace create LINKS`로 namespace를 만들고 ID와 도메인을 교체하세요.

### 초기 비밀번호: 한 번만 설정

Cloudflare Worker → Settings → Variables and Secrets에서 **Secret**으로 다음 값을 설정합니다.

| 이름 | 값 |
|---|---|
| `ADMIN_PASSWORD` | 본인이 정한 초기 관리자 비밀번호, 10~256자 |

명령어로도 설정할 수 있습니다.

```bash
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

`https://go.hellojyp.com/admin`에서 초기 비밀번호로 로그인합니다.
상단 **비밀번호 변경**에서 기억하기 쉬운 새 비밀번호(10~128자)로 변경하세요.
이후에는 새 비밀번호로 로그인합니다. 로그아웃하지 않으면 최대 7일 유지됩니다.

기존 `ADMIN_TOKEN`만 설정된 경우 그 값을 초기 비밀번호로 사용할 수 있습니다(10~256자).
비밀번호를 KV에 저장한 뒤에는 초기 Secret 값으로 로그인할 수 없습니다.
기존 `ADMIN_TOKEN`의 Bearer 인증도 비밀번호 변경 후에는 차단됩니다.
비밀번호를 바꿔도 별도로 발급한 API 키는 연동 유지를 위해 보존됩니다.

### 비밀번호를 잊었을 때

1. Cloudflare에서 `ADMIN_PASSWORD` Secret을 새 초기 비밀번호로 설정합니다.
2. 이 서비스의 KV namespace에서 **`auth:credentials` 키만** 삭제합니다. 링크나 API 키 데이터는 건드리지 않습니다.
3. 전파 후 새 초기 비밀번호로 로그인하고 관리 화면에서 비밀번호를 다시 변경합니다.

Secret만 바꾸면 KV에 이미 저장된 비밀번호는 바뀌지 않습니다.
복구 시 기존 쿠키는 새 초기 비밀번호와 일치하지 않으므로 인증되지 않습니다(전파 지연 적용).

## API 키 사용

로그인 → 상단 **API 키** → 이름 입력 → **API 키 발급**.
발급된 키는 한 번만 표시됩니다. 복사 후 해당 프로그램에 보관하세요.
서버에는 키 원문을 저장하지 않으므로 잊으면 새 키를 발급해야 합니다.

```bash
curl https://go.hellojyp.com/api/links \
  -H 'Authorization: Bearer YOUR_API_KEY'

curl https://go.hellojyp.com/api/links \
  -X POST \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com/long/path","expiresAt":null}'
```

생성 응답의 `code`를 `https://go.hellojyp.com/<code>`에 붙이면 단축 링크입니다.
불필요한 API 키는 관리 화면에서 **폐기**합니다. 비밀번호 변경만으로 API 키가 폐기되지는 않습니다.

| 요청 | 인증 | 기능 |
|---|---|---|
| `GET /`, `/admin` | 공개 | 로그인·관리 화면 |
| `POST /api/auth/login` | 비밀번호 | 로그인 쿠키 발급 |
| `GET /api/auth/session` | 관리자 쿠키 | 로그인 유지 확인 |
| `POST /api/auth/logout` | 쿠키 삭제 | 현재 브라우저 로그아웃 |
| `POST /api/auth/password` | 관리자 + 현재 비밀번호 | 비밀번호 변경 |
| `GET /api/keys?cursor=...` | 관리자 | API 키 목록, 50개 단위 |
| `POST /api/keys` | 관리자 | `{ "name": "iPhone 단축어" }`로 키 발급 |
| `DELETE /api/keys/:id` | 관리자 | API 키 폐기 |
| `GET /api/links?cursor=...` | 관리자 또는 API 키 | 링크 목록, 50개 단위 |
| `POST /api/links` | 관리자 또는 API 키 | 링크 생성 |
| `DELETE /api/links/:code` | 관리자 또는 API 키 | 링크 삭제 |
| `GET /:code`, `HEAD /:code` | 공개 | 302 리다이렉트 |

비밀번호 변경 요청: `{ "currentPassword": "...", "newPassword": "..." }`.
`expiresAt`은 ISO 8601 문자열 또는 `null`이며 최소 1분 이후여야 합니다.
화면 입력 만료일은 브라우저 현지 시간으로 해석합니다.
URL은 정규화 후 최대 4,096자, 생성 요청 본문은 최대 8 KiB입니다.
다른 Origin의 브라우저 변경 요청과 CORS는 허용하지 않습니다.

## KV 조회 방식

**로그인 전 화면을 여는 것만으로 링크 목록을 list하지 않습니다.**
페이지 로드 시 로그인 유지 확인을 하고, 로그인 성공 또는 유지된 로그인 확인 후 목록을 가져옵니다.

| 작업 | KV 작업 |
|---|---|
| 로그인 유지 확인·비밀번호 로그인 | 인증 설정 `get` 1회 |
| 관리자 링크 목록 한 페이지 | 인증 설정 `get` 1회 + `list` 1회 + 링크 `get` 최대 50회 |
| 목록 새로고침·더 불러오기 | 위와 동일 |
| 검색창 입력 | 추가 KV 조회 없음, 불러온 링크만 검색 |
| 일반 단축 링크 접속 | 해당 링크 `get` 1회, 인증·목록 조회 없음 |
| API 키로 링크 요청 | 위 인증 설정 조회 외 API 키 해시 `get` 1회 추가 |
| API 키 관리 화면 열기 | 인증 설정 `get` 1회 + 키 `list` 1회 |
| 링크·API 키 생성 | 인증 조회 후 `put` 1회 |
| 링크·API 키 삭제 | 인증 조회 후 `delete` 1회 |
| 비밀번호 변경 | 인증 설정 `get` 후 `put` 1회 |

KV 키는 `link:<code>`, `auth:credentials`, `apikey:<SHA256 해시>`로 구분합니다.
링크 metadata에는 생성·만료 정보만 저장하고 전체 URL은 값에 저장하여 metadata 크기 제한을 피합니다.
API 키 metadata에는 이름·생성일만 저장합니다.

## KV의 일관성 제약

KV는 eventual consistency입니다. 생성·삭제·비밀번호 변경·키 폐기가 다른 지역에 반영되기까지 **60초 이상** 걸릴 수 있습니다.
같은 지역에서도 즉시 반영을 보장하지 않으며, 존재하지 않는 키의 조회도 캐시됩니다.

- 비밀번호 변경 시 현재 브라우저 쿠키는 즉시 삭제합니다. 다른 지역의 기존 세션과 이전 비밀번호는 인증 설정 전파 후 거부됩니다.
- 변경 직후 새 비밀번호로 로그인되지 않으면 잠시 후 다시 시도하세요. 인증 정보가 즉시 확인되는 것처럼 우회하지 않습니다.
- 키 폐기 직후에도 다른 지역에서는 잠시 사용할 수 있습니다.
- 만료는 KV expiration과 Worker 시간 검사에 모두 적용하고 리다이렉트는 `no-store`로 응답합니다.
- 링크 코드는 96비트 난수입니다. 충돌 가능성은 매우 낮지만 KV에는 원자적 조건부 저장이 없어 절대 고유성을 보장하지 않습니다.
- 사용자 지정 코드, 목적지 수정, 정확한 클릭 수 집계는 포함하지 않습니다.
- 목록은 코드 순으로 페이지 조회 후 불러온 항목만 생성일 내림차순으로 정렬합니다. 전체 데이터 최신순 조회·전체 검색은 지원하지 않습니다.
- 로그아웃은 현재 브라우저 쿠키를 지웁니다. 이미 복사된 개별 쿠키의 서버 폐기는 지원하지 않으며, 비밀번호 변경으로 모든 세션 서명을 교체할 수 있습니다.

공식 문서: [KV 일관성](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## 로컬 실행·검증

```bash
cp .dev.vars.example .dev.vars
# .dev.vars에 본인의 초기 ADMIN_PASSWORD 입력
npm run dev
```

`http://localhost:8787/admin`에서 확인합니다. 로컬 KV는 운영과 분리됩니다.
HTTP 로컬 개발에서만 Secure 접두어 없는 개발용 쿠키를 사용하고, HTTPS에서는 `__Host-` 쿠키를 사용합니다.
`.dev.vars`는 Git에 포함되지 않습니다.

```bash
npm test
npm run check
npm run build
```

테스트는 Node.js 내장 러너와 메모리 KV 대역으로 동작·인증·비밀번호 변경·세션 만료·API 키 권한을 검증합니다.
타입 검사와 Wrangler dry run도 제공합니다. 실제 Cloudflare 계정 배포·전파 시간·브라우저 시각 검증은 별도입니다.

### GitHub 자동 배포

Cloudflare Worker의 Git 연결에서 이 저장소의 `main`을 선택합니다.
프로젝트 루트는 `/`, 빌드 명령은 `npm run check && npm test`, 배포 명령은 `npm run deploy`입니다.
`ADMIN_PASSWORD`는 운영 Worker의 Secret으로 설정하며 GitHub에 넣지 않습니다.
KV 바인딩은 `LINKS`, 정적 자산은 `ASSETS`, 로그인 제한은 `LOGIN_RATE_LIMITER`입니다.
Rate Limit namespace ID `2026102019`는 동일 계정에서 다른 서비스와 공유하지 않도록 사용하세요.

## 파일 구조

```text
src/index.ts         Worker 라우팅·관리 API·리다이렉트
src/auth.ts          비밀번호 해시·서명 쿠키·API 키 인증
public/index.html    관리자 화면
public/app.js        로그인·비밀번호·API 키·링크 관리
public/style.css     반응형 스타일
wrangler.jsonc       KV·도메인·정적 자산·요청 제한 설정
test/*.test.mjs      동작·인증 검증
```
