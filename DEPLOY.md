# 내 서버 + 내 도메인으로 배포하기

Ubuntu 22.04/24.04 서버 기준입니다. 아래에서 **`liar.example.com`은 쓰실 주소**, **`SERVER_IP`는 서버의 공인 IP**로 바꿔 읽으세요.

구성은 이렇습니다.

```
브라우저 ──https/wss──▶ nginx(443, 인증서) ──http──▶ Node 서버(127.0.0.1:3000)
```

Node 서버는 서버 내부(127.0.0.1)에서만 받고, 바깥에서는 nginx를 통해서만 들어옵니다.

---

## 1. 도메인 DNS 설정

도메인을 산 곳(가비아, Cloudflare, 후이즈 등)의 DNS 관리에서 레코드를 하나 추가합니다.

| 타입 | 이름(호스트) | 값 |
| --- | --- | --- |
| A | `liar` | `SERVER_IP` |

루트 도메인(`example.com`) 자체를 쓰려면 이름을 `@`로 합니다.
**Cloudflare**를 쓴다면 처음엔 프록시(주황 구름)를 끄고(회색) 인증서를 받은 뒤 켜도 됩니다. Cloudflare는 WebSocket을 지원합니다.

반영 확인 (내 PC에서):

```bash
nslookup liar.example.com
```

## 2. 방화벽 / 보안 그룹

열어야 할 포트는 **22(SSH), 80, 443** 세 개뿐입니다. 3000번은 열지 마세요.

- AWS EC2 등 클라우드: 콘솔의 **보안 그룹 인바운드 규칙**에 80, 443 추가
- 서버의 ufw를 쓰는 경우:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

## 3. Node.js 설치 (18 이상)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt-get install -y nodejs nginx
```

```bash
node -v
```

> nvm으로 설치했다면 `which node`로 나온 경로를 7단계 서비스 파일의 `ExecStart`에 넣어야 합니다.

## 4. 파일 올리기

내 PC에서 `liar-game-v0.1.zip`을 서버로 복사합니다 (`key.pem`, `ubuntu`는 내 접속 정보로).

```bash
scp -i key.pem liar-game-v0.1.zip ubuntu@SERVER_IP:~
```

서버에서 압축을 풀고 의존성을 설치합니다.

```bash
sudo apt-get install -y unzip && sudo mkdir -p /opt/liar-game && sudo unzip -o ~/liar-game-v0.1.zip -d /opt/liar-game
```

```bash
cd /opt/liar-game && sudo npm ci --omit=dev
```

전용 사용자를 만들어 그 권한으로 돌립니다.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin liar; sudo chown -R liar:liar /opt/liar-game
```

## 5. 동작 확인 (선택)

```bash
cd /opt/liar-game && HOST=127.0.0.1 node server.js
```

다른 SSH 창에서 `curl http://127.0.0.1:3000/health` → `{"ok":true,...}`가 나오면 Ctrl+C로 끕니다.

## 6. nginx 연결

```bash
sudo cp /opt/liar-game/deploy/nginx-liar-game.conf /etc/nginx/sites-available/liar-game
```

```bash
sudo nano /etc/nginx/sites-available/liar-game
```

`server_name liar.example.com;`을 내 주소로 바꾸고 저장한 뒤:

```bash
sudo ln -sf /etc/nginx/sites-available/liar-game /etc/nginx/sites-enabled/liar-game && sudo nginx -t && sudo systemctl reload nginx
```

## 7. 서버를 서비스로 등록 (재부팅해도 자동 실행)

```bash
sudo cp /opt/liar-game/deploy/liar-game.service /etc/systemd/system/liar-game.service
```

```bash
sudo nano /etc/systemd/system/liar-game.service
```

`ALLOWED_ORIGINS=https://liar.example.com`을 내 주소로 바꿉니다 (**https:// 포함, 끝에 / 없이**). 저장 후:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now liar-game
```

```bash
sudo systemctl status liar-game
```

## 8. HTTPS 인증서 (무료, 자동 갱신)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

```bash
sudo certbot --nginx -d liar.example.com
```

이메일 입력과 약관 동의를 마치면 nginx 설정에 443 블록이 자동으로 추가됩니다. 이제 **https://liar.example.com** 으로 접속하면 됩니다.

---

## 업데이트할 때

새 zip을 올린 뒤:

```bash
sudo unzip -o ~/liar-game-v0.1.zip -d /opt/liar-game && cd /opt/liar-game && sudo npm ci --omit=dev && sudo chown -R liar:liar /opt/liar-game && sudo systemctl restart liar-game
```

재시작하면 **진행 중인 방과 점수는 사라집니다** (메모리에만 저장). 다들 게임 안 할 때 하세요.

## 로그 보기

```bash
sudo journalctl -u liar-game -f
```

## 잘 안 될 때

| 증상 | 확인할 것 |
| --- | --- |
| 페이지는 뜨는데 "다시 연결하는 중…"이 계속 뜸 | `ALLOWED_ORIGINS`가 브라우저 주소창과 정확히 같은지 (`https://`, `www` 유무). nginx 설정에 `Upgrade`/`Connection` 헤더가 있는지 |
| 502 Bad Gateway | `systemctl status liar-game`으로 Node 서버가 떠 있는지, 로그에 오류가 있는지 |
| 접속 자체가 안 됨 | DNS 반영(최대 수십 분), 보안 그룹/방화벽 80·443 |
| certbot 실패 | 80번 포트가 열려 있는지, DNS가 이 서버 IP를 가리키는지 |
| 서버 메모리가 작음 | 이 게임은 수십 MB면 충분합니다. 1GB 인스턴스로도 됩니다 |

## nginx 대신 Caddy를 쓰는 경우

6·8단계를 건너뛰고 Caddy를 설치한 뒤 `deploy/Caddyfile` 내용을 `/etc/caddy/Caddyfile`에 넣고 `sudo systemctl reload caddy` 하면 HTTPS와 WebSocket 프록시가 한 번에 됩니다. (nginx가 80/443을 쓰고 있으면 먼저 꺼야 합니다.)
