# Render로 배포하기 (+ 내 도메인)

## 1. GitHub에 올리기
GitHub에서 빈 저장소(예: `liar-game`, Private 가능, README 추가 체크 해제)를 만들고 이 폴더를 push 합니다.

## 2. Render에서 서비스 만들기
1. https://render.com 에 GitHub 계정으로 가입/로그인
2. **New → Blueprint** → 방금 만든 저장소 선택 → `render.yaml` 내용 확인 후 **Apply**
   - Blueprint 대신 **New → Web Service** 로 만들 경우:
     Runtime `Node`, Region `Singapore`, Build `npm ci --omit=dev`, Start `npm start`, Instance type `Free`,
     Advanced → Health Check Path `/health`
3. 빌드가 끝나면 `https://liar-game-xxxx.onrender.com` 같은 주소가 생깁니다. 접속해서 방이 만들어지는지 확인하세요.

## 3. 내 도메인 연결
1. Render 서비스 → **Settings → Custom Domains → Add** → `liar.example.com` 입력
2. Render가 보여 주는 값으로 도메인 업체 DNS에 레코드 추가

   | 타입 | 이름 | 값 |
   | --- | --- | --- |
   | CNAME | `liar` | `liar-game-xxxx.onrender.com` (Render가 알려 준 값) |

   루트 도메인(`example.com`)을 쓰면 Render 안내대로 A 레코드를 넣습니다.
   Cloudflare라면 처음엔 프록시를 끄고(회색 구름) 연결 확인 후 켜세요.
3. Render 화면에서 **Verify** → 인증서가 자동 발급되면 `https://liar.example.com` 으로 접속됩니다.

## 4. (권장) 접속 출처 제한
서비스 → **Environment → Add Environment Variable**

```
ALLOWED_ORIGINS = https://liar.example.com,https://liar-game-xxxx.onrender.com
```

저장하면 자동 재배포됩니다. 주소창의 주소와 정확히 같아야 합니다 (`https://` 포함, 끝 `/` 없이). 틀리면 "다시 연결하는 중…"이 계속 뜹니다.

## 알아 둘 점
- **무료 플랜은 한동안 요청이 없으면 잠듭니다.** 잠든 뒤 첫 접속은 깨어나는 데 수십 초 걸리고, 그때 메모리에 있던 방과 점수는 사라집니다. 상시로 쓰려면 유료 인스턴스로 바꾸세요.
- 재배포(push)할 때도 방과 점수가 초기화됩니다.
- 인스턴스는 1대로 두세요. 늘리면 같은 방 사람들이 서로 다른 서버에 붙습니다.
- 로그: Render 서비스 → **Logs**
