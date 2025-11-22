# Mosaic Reveal Game

Public Oracle Pattern을 사용한 모자이크 공개 게임입니다. 한 명이 Reveal을 하면 모든 사용자에게 타일이 공개됩니다.

## 아키텍처

1. **Setup**: 이미지 조각내기 → AES 암호화 → Walrus 업로드 → AES 키를 Seal로 잠금 → SUI 등록
2. **Action**: 유저가 Reveal 요청 (SUI 트랜잭션)
3. **Bot**: 이벤트 감지 → Seal에게 AES 키 복호화 요청 → 복호화된 AES 키를 SUI에 공개
4. **Frontend**: SUI에서 공개된 AES 키 감지 → Walrus에서 암호화된 이미지 다운로드 → 브라우저에서 AES 복호화 → 표시

## 초기 설정

### 1. 전체 자동 설정 (권장)

```bash
./setup.sh
```

이 스크립트가 다음을 자동으로 수행합니다:

- 컨트랙트 배포
- `.env.public` 파일 업데이트
- 게임 설정 (`npm run setup`)
- 프론트엔드 시작

### 2. 수동 설정

#### Step 1: 컨트랙트 배포

```bash
cd contract
sui client publish --json --gas-budget 100000000
```

배포 후 출력에서 `packageId`와 `OracleCap` ID를 확인하고 `.env.public` 파일들을 업데이트하세요.

#### Step 2: 환경 변수 설정

**backend/.env.public**:

```env
PACKAGE_ID="0x..."
ORACLE_CAP_ID="0x..."
ORACLE_PRIVATE_KEY="suiprivkey..."  # 실제 private key 필요
```

**frontend/.env.public**:

```env
VITE_TESTNET_PACKAGE_ID=0x...
VITE_TESTNET_GAME_ID=0x...  # setup 후 업데이트 필요
```

#### Step 3: 게임 설정

```bash
cd backend
npm install
npm run setup
```

이 명령은:

- `sui.png` 이미지를 10x10 그리드로 분할
- 각 타일을 AES-256-GCM으로 암호화
- 암호화된 타일을 Walrus에 업로드
- AES 키를 Seal로 암호화하여 체인에 저장
- 결과를 `tmp/testnet-<timestamp>/` 디렉토리에 저장

#### Step 4: Game ID 업데이트

`backend/tmp/testnet-<timestamp>/setup_summary.json`에서 `gameId`를 확인하고 `frontend/.env.public`의 `VITE_TESTNET_GAME_ID`를 업데이트하세요.

## 실행 방법

### 1. 백엔드 봇 실행 (필수)

백엔드 봇은 Reveal 요청을 감지하고 Seal을 통해 AES 키를 복호화하여 체인에 공개합니다.

```bash
cd backend
npm run start
```

봇이 실행되면:

- `TileRevealRequested` 이벤트를 감시합니다
- 이벤트 발생 시 Seal을 통해 AES 키를 복호화합니다
- 복호화된 키를 `fulfill_reveal` 함수를 통해 체인에 공개합니다

### 2. 프론트엔드 실행

```bash
cd frontend
npm install  # 처음 한 번만
npm run dev
```

프론트엔드는 `http://localhost:5173`에서 실행됩니다.

## 게임 플레이 방법

### 1. 지갑 연결

프론트엔드에서 "Connect Wallet" 버튼을 클릭하여 Sui 지갑을 연결하세요.

### 2. 타일 공개 요청

- 타일을 클릭하면 Reveal 요청이 전송됩니다
- 1 SUI (또는 설정된 금액)가 지불됩니다
- 백엔드 봇이 자동으로 처리하여 타일이 공개됩니다

### 3. 타일 확인

- 공개된 타일은 자동으로 이미지가 표시됩니다
- 프론트엔드가 체인에서 AES 키를 감지하고 Walrus에서 이미지를 다운로드하여 브라우저에서 복호화합니다

### 4. 정답 맞추기 (선택사항)

1. 정답과 Salt를 입력합니다
2. "커밋" 버튼을 클릭하여 해시값을 제출합니다
3. "정답 제출" 버튼을 클릭하여 실제 정답을 공개합니다
4. 정답이 맞으면 상금을 받습니다

## 디렉토리 구조

```
backend/
├── tmp/
│   └── testnet-<timestamp>/     # 각 setup 실행마다 생성되는 타임스탬프 디렉토리
│       ├── tiles/               # 원본 타일 이미지들
│       ├── encrypted/           # AES 암호화된 타일들
│       ├── manifest.json        # 타일 매핑 정보
│       ├── tiles_upload_results.json
│       ├── manifest_upload_results.json
│       └── setup_summary.json   # 게임 ID 등 전체 요약
└── src/
    ├── setup_game.ts            # 게임 설정 스크립트
    └── index.ts                 # 백엔드 봇 (Reveal 처리)
```

## 주요 파일

- `setup.sh`: 전체 자동 설정 스크립트
- `backend/src/setup_game.ts`: 게임 생성 및 암호화
- `backend/src/index.ts`: 백엔드 봇 (Reveal 처리)
- `frontend/src/App.tsx`: 프론트엔드 UI 및 복호화 로직
- `contract/sources/curg_mosaic_reveal.move`: Move 스마트 컨트랙트

## 환경 변수

### Backend (.env)

- `PACKAGE_ID`: 배포된 패키지 ID
- `ORACLE_CAP_ID`: OracleCap 객체 ID
- `ORACLE_PRIVATE_KEY`: 봇이 사용할 Sui private key

### Frontend (.env.public)

- `VITE_TESTNET_PACKAGE_ID`: 패키지 ID
- `VITE_TESTNET_GAME_ID`: 게임 객체 ID
- `VITE_MODULE_NAME`: 모듈 이름 (기본값: "mosaic")

## 문제 해결

### 백엔드 봇이 작동하지 않을 때

1. `.env` 파일에 `ORACLE_PRIVATE_KEY`가 올바르게 설정되어 있는지 확인
2. `ORACLE_CAP_ID`가 올바른지 확인
3. 봇 로그에서 에러 메시지 확인

### 프론트엔드에서 타일이 표시되지 않을 때

1. 백엔드 봇이 실행 중인지 확인
2. 브라우저 콘솔에서 에러 확인
3. `VITE_TESTNET_GAME_ID`가 올바른지 확인
4. Manifest가 Walrus에서 다운로드 가능한지 확인

### 타일이 공개되지 않을 때

1. Reveal 요청 트랜잭션이 성공했는지 확인
2. 백엔드 봇이 이벤트를 감지했는지 확인 (봇 로그 확인)
3. Seal 복호화가 성공했는지 확인 (봇 로그 확인)

## 추가 명령어

### Backend

```bash
# 게임 설정
npm run setup

# 백엔드 봇 실행
npm run start

# Walrus blob 읽기
npm run read-blob <blobId>

# Walrus blob 복호화
npm run decrypt-blob <blobId> <encryptionId>

# Walrus blob 삭제
npm run delete-blob <blobId>
```

### Contract

```bash
# 컨트랙트 빌드
sui move build

# 컨트랙트 배포
sui client publish --json --gas-budget 100000000
```

## 참고사항

- 각 `setup` 실행은 `tmp/testnet-<timestamp>/` 디렉토리에 결과를 저장하므로 이전 결과가 덮어쓰이지 않습니다
- 백엔드 봇은 계속 실행되어야 Reveal 요청을 처리할 수 있습니다
- 프론트엔드는 10초마다 자동으로 게임 상태를 새로고침합니다
