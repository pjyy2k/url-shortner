# URL Shortner

Cloudflare Workers + Workers KV로 운영하는 개인용 URL 단축 서비스입니다.
**링크 생성·목록 조회·삭제는 관리자만**, 단축 링크 접속은 누구나 가능합니다.

## 기능

- 한국어 관리자 화면, 모바일 대응
- 관리자 토큰 인증, 로그인 정보는 탭 메모리에서만 보관
- 무작위 16자리 단축 코드(96비트), 링크 복사
- 선택적 만료일, 만료된 링크의 리다이렉트 차단
- 링크 목록 50개 단위 페이지 조회, 불러온 링크 검색
- 삭제 확인, 저장·배포 지연 안내
- HTTP/HTTPS URL 검증, 자체 호스트로 향하는 링크 및 URL 내 인증정보 거부
- 런타임 외부 서비스 호출 없음: Worker가 원래 주소를 가져오는 대신 브라우저에 302 응답

관리자 로그인 화면 자체는 공개됩니다. 토큰이 없으면 API의 조회·생성·삭제가 모두 차단됩니다.
별도 회원가입이나 공개 링크 생성 기능은 없습니다.

## 준비

Node.js **22.18 이상**, Cloudflare 계정이 필요합니다.

```bash
git clone https://github.com/pjyy2k/url-shortner.git
cd url-shortner
npm ci
npx wrangler login
npx wrangler kv namespace create LINKS
```

출력된 KV namespace의 `id`를 `wrangler.jsonc`에 입력합니다.

```json
"kv_namespaces": [
  { "binding": "LINKS", "id": "실제_NAMESPACE_ID" }
]
```

## 로컬 실행

```bash
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

출력된 무작위 값을 `.dev.vars`의 `ADMIN_TOKEN`에 넣습니다. 토큰은 공백 없는 32~256자입니다.
`.dev.vars`는 Git에 포함되지 않습니다. 예제 값을 그대로 사용하지 마세요.

```bash
npm run dev
```

`http://localhost:8787/admin`을 열고 토큰으로 로그인합니다.
로컬 실행은 로컬 KV를 사용하며 실제 운영 데이터와 분리됩니다.
단축 링크는 반드시 **서비스 외부 호스트**를 목적지로 지정합니다.

## Cloudflare 배포

```bash
npx wrangler secret put ADMIN_TOKEN
# 입력 프롬프트에 로컬에서 생성한 토큰 또는 별도의 운영 토큰 입력
npm run deploy
```

- `ADMIN_TOKEN`은 Cloudflare Worker secret으로 저장하며 `wrangler.jsonc`나 GitHub에 넣지 않습니다.
- 배포 출력의 `https://url-shortner.<계정>.workers.dev/admin`에서 관리합니다.
- 커스텀 도메인은 Cloudflare의 해당 Worker → Settings → Domains & Routes → Add → Custom Domain에서 연결합니다.
- 관리 화면을 연 도메인이 생성되는 단축 링크의 도메인이 됩니다. 실제 공유용 도메인에서 관리 화면을 사용하세요.
- 토큰 변경은 `npx wrangler secret put ADMIN_TOKEN`으로 다시 설정합니다. 기존 토큰은 이후 요청에서 거부됩니다.
- 새로고침·탭 종료 시 다시 로그인해야 합니다. 로그아웃은 현재 화면과 메모리의 토큰을 지웁니다.

### GitHub 연동 자동 배포

Cloudflare Workers의 Git 저장소 연결 기능에서 이 저장소와 `main` 브랜치를 선택합니다.

- 프로젝트 루트: `/`
- 빌드 명령: `npm run check && npm test`
- 배포 명령: `npm run deploy`
- `wrangler.jsonc`의 KV ID를 먼저 실제 값으로 변경하고 커밋합니다.
- 운영 Worker에 `ADMIN_TOKEN` secret을 설정합니다. 빌드 환경 변수에 토큰을 넣을 필요는 없습니다.
- KV 바인딩 이름은 코드와 동일한 `LINKS`를 사용합니다.

## API

관리 API는 모두 `Authorization: Bearer <ADMIN_TOKEN>`이 필요합니다.
브라우저의 다른 Origin에서 보내는 변경 요청은 거부합니다. CORS는 허용하지 않습니다.

| 요청 | 기능 |
|---|---|
| `GET /` 또는 `/admin` | 관리자 로그인·관리 화면 |
| `GET /api/links?cursor=...` | 목록, 최대 50개와 다음 cursor |
| `POST /api/links` | `{ "url": "https://example.com", "expiresAt": null }` |
| `DELETE /api/links/:code` | 링크 삭제 |
| `GET /:code`, `HEAD /:code` | 누구나 302 리다이렉트 |

`expiresAt`은 ISO 8601 문자열 또는 `null`입니다. 생성 시 최소 1분 이후여야 합니다.
화면에서 입력한 만료일은 사용 중인 브라우저의 현지 시간으로 해석합니다.
URL은 정규화 후 최대 4,096자, 생성 요청 본문은 최대 8 KiB입니다.

## KV 설계와 제약

키: `link:<code>`. 값에는 `url`, `createdAt`, `expiresAt`을 저장합니다.
KV metadata에는 생성·만료 정보만 저장하여 1,024바이트 제한을 피합니다.
목록 조회는 KV list 1회와 해당 페이지의 링크별 get을 사용합니다(최대 50회).
일반 단축 링크 접속은 KV get 1회, 생성은 put 1회, 삭제는 delete 1회입니다.

- KV는 eventual consistency입니다. 생성·삭제가 다른 지역에 보이기까지 **60초 이상** 걸릴 수 있으며 같은 지역에서도 즉시 반영을 보장하지 않습니다. 새 링크가 일시적으로 404를 반환하거나 삭제한 링크가 잠시 동작할 수 있습니다.
- 존재하지 않는 키의 조회도 캐시됩니다. KV 반영 지연을 숨기기 위해 생성 성공 후 재조회하지 않고 생성 응답을 화면에 표시합니다.
- 만료일은 KV expiration과 Worker의 시간 검사에 모두 적용합니다. 브라우저 리다이렉트는 `no-store`로 응답하여 별도의 리다이렉트 캐시를 만들지 않습니다.
- 코드 생성에는 암호학적 난수 96비트를 사용합니다. 충돌 가능성은 매우 낮지만 KV에는 원자적인 '없을 때만 저장'이 없으므로 절대적인 고유성은 보장하지 않습니다.
- 사용자 지정 코드, 링크 목적지 수정, 정확한 클릭 수 집계는 포함하지 않습니다. 이를 추가하려면 원자적 쓰기·카운팅에 적합한 Durable Objects 등의 별도 설계가 필요합니다.
- 목록은 코드 순으로 페이지를 가져오며, 화면에서는 **불러온 항목만** 생성일 내림차순으로 정렬·검색합니다. 전체 데이터의 최신순 페이지 조회나 전체 URL 검색을 보장하지 않습니다.
- 원래 URL을 서버에서 fetch하지 않으므로 목적지의 정상 동작이나 안전성을 검사하지 않습니다. 관리자 토큰을 가진 사람만 링크를 생성할 수 있습니다.

공식 문서: [KV 동작과 일관성](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [KV 쓰기](https://developers.cloudflare.com/kv/api/write-key-value-pairs/), [Workers 정적 자산](https://developers.cloudflare.com/workers/static-assets/).

## 검증

```bash
npm test
npm run check
npm run build
```

`npm test`는 Node.js 내장 테스트 러너와 메모리 KV 대역으로 인증, 생성·리다이렉트·삭제, 만료, URL 검증, 페이지 조회, 오류 응답을 검증합니다.
`npm run check`는 TypeScript 검사, `npm run build`는 Wrangler 배포 dry run입니다.
실제 Cloudflare 계정에 대한 배포와 전 세계 KV 전파 시간은 이 테스트에 포함되지 않습니다.

## 파일 구조

```text
src/index.ts        Worker, 관리자 API, 리다이렉트
public/index.html   관리자 화면
public/app.js       인증·생성·목록·삭제 UI
public/style.css    반응형 스타일
wrangler.jsonc      KV·정적 자산 설정
test/worker.test.mjs 동작 검증
```
