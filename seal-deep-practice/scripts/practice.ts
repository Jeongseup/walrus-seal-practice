import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromHex, toHex } from "@mysten/sui/utils";
import { SealClient, SessionKey } from "@mysten/seal";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Transaction } from "@mysten/sui/transactions";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.public first (public variables)
dotenv.config({ path: path.join(__dirname, "../.env.public") });

// Then load .env (private variables, will override .env.public if same key exists)
dotenv.config({ path: path.join(__dirname, "../.env") });

// --- 환경 변수 체크 ---
if (!process.env.PRIVATE_KEY) {
  throw new Error("❌ PRIVATE_KEY environment variable missing");
}
if (!process.env.PACKAGE_ID) {
  throw new Error("❌ PACKAGE_ID environment variable missing");
}

const NETWORK = "testnet";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PACKAGE_ID =
  "0x85aa5bd7dd875edfcbea24168838daf6a23bb3f7b1adef83864edf9245259636";
// PACKAGE_ID=0x85aa5bd7dd875edfcbea24168838daf6a23bb3f7b1adef83864edf9245259636

// Seal 서버 설정
const serverObjectIds = [
  "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
];

const { secretKey } = decodeSuiPrivateKey(PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

// SealClient 초기화
const sealClient = new SealClient({
  suiClient: suiClient,
  serverConfigs: serverObjectIds.map((id) => ({
    objectId: id,
    weight: 1,
  })),
  verifyKeyServers: false,
});

/**
 * 메인 함수
 */
async function main() {
  console.log(`\n🚀 Encrypt My Secret With Seal`);
  console.log(`📝 User Address: ${keypair.toSuiAddress()}`);
  console.log(`📦 Package ID: ${PACKAGE_ID}`);
  console.log(`🌐 Network: ${NETWORK}`);

  const mysecret = "mysupersecret";
  // echo -n 'mysupersecret' | xxd -p => 6d797375706572736563726574
  // 🔐 Secret (hex): 6d797375706572736563726574
  const encoder = new TextEncoder();
  const secretHex = toHex(encoder.encode(mysecret));
  const mysecretBz = fromHex(secretHex);

  console.log(`\n📄 Secret: ${mysecret}`);
  console.log(`🔐 Secret (hex): ${secretHex}`);
  console.log(
    `📊 Secret size: ${mysecretBz.length} bytes (${
      mysecret.length / 2
    } hex chars)`
  );

  // IBM
  const myId = "0000";
  // 5. Seal로 데이터 암호화
  console.log(`\n🔐 Encrypting secret key with Seal...`);
  const { encryptedObject: encryptedData, key: dmeKey } =
    await sealClient.encrypt({
      threshold: 1,
      packageId: PACKAGE_ID,
      id: myId,
      data: mysecretBz,
    });

  const symmetricKey = toHex(dmeKey);
  console.log(`Symmetric Key: ${symmetricKey}`);

  const encryptedDataHex = toHex(encryptedData);
  console.log(`Encrypted Data: ${encryptedDataHex}`);
  console.log(
    `✅ Secret key encrypted! Encrypted size: ${encryptedData.length} bytes`
  );

  const keyServers = await sealClient.getKeyServers();
  for (const keyServer of keyServers) {
    console.log([...keyServer.entries()]); // Map의 경우
  }

  // 2. SessionKey 생성 및 서명
  // 클라이언트는 브라우저/로컬에서 **임시 ElGamal 키 쌍(Public/Private)**을 새로 생성합니다. 이것이 sessionKey입니다.
  // 그리고 유저의 지갑(signer)으로 "이 임시 공개키는 내가 만든 거야"라는 메시지에 서명합니다.
  // 서버에 [임시 공개키 + 유저의 서명 + txBytes]를 보냅니다.
  // 서버는 유저의 서명을 확인한 뒤, 키 조각을 임시 공개키로 암호화해서 응답합니다.
  // 클라이언트는 메모리에 들고 있던 임시 개인키로 응답을 복호화합니다.
  // 즉, SessionKey는 일회용(또는 세션용) 보안 터널을 뚫기 위한 전용 키이며, 유저의 지갑 키는 이 터널의 주인을 보증하는 신분증 역할을 합니다.
  console.log(`\n🔑 Creating SessionKey...`);
  const sessionKey = await SessionKey.create({
    address: keypair.toSuiAddress(),
    packageId: PACKAGE_ID,
    ttlMin: 10,
    suiClient,
  });

  const personalMessage = sessionKey.getPersonalMessage();
  // NOTE: 이 부분은 frontend에서 처리해야함. '
  // ref; https://github.com/MystenLabs/seal/blob/main/examples/frontend/src/AllowlistView.tsx#L4
  const signature = await keypair.signPersonalMessage(personalMessage);
  await sessionKey.setPersonalMessageSignature(signature.signature);
  console.log(`✅ SessionKey created and signed`);

  const tx = new Transaction();
  // ids.forEach((id) => {
  //   const idStr = typeof id === "string" ? id : toHex(id);
  //   moveCallConstructor(tx, idStr);
  // });

  const txBytes = await tx.build({ client: suiClient });
  console.log(`🔑 Authentication Token txBytes: ${txBytes}`);

  try {
    // 원본 코드처럼 ids를 그대로 전달 (fetchKeys가 적절한 형식으로 처리)
    await sealClient.fetchKeys({
      ids: [myId], // [1] 대상: "누구의 키를 가져올 것인가?"
      txBytes, // [2] 권한 증명: "내가 이 키를 가져갈 자격이 있다는 증거"
      sessionKey, // [3] 보안 채널: "가져오는 도중에 남들이 못 보게 이걸로 잠가줘"
      threshold: 1, // [4] 성공 기준: "최소 몇 개의 조각이 모여야 성공으로 칠 것인가?"
    });
    console.log(`✅ Fetched keys for batch`);
  } catch (err) {
    console.error(`❌ Error fetching keys:`, err);
  }
}

//   // 4. Encryption ID 생성 (React 코드 방식: policyObjectBytes + nonce)
//   // React 코드: const policyObjectBytes = fromHex(policyObject);
//   //            const id = toHex(new Uint8Array([...policyObjectBytes, ...nonce]));
//   const policyObjectBytes = fromHex(
//     allowlistId.startsWith("0x") ? allowlistId.slice(2) : allowlistId
//   );
//   const nonce = crypto.getRandomValues(new Uint8Array(5));
//   const encryptionId = toHex(new Uint8Array([...policyObjectBytes, ...nonce]));

//   console.log(`\n🔑 Encryption ID (hex): ${encryptionId}`);
//   console.log(`📌 Nonce (hex): ${toHex(nonce)}`);
//   console.log(`📝 Allowlist ID: ${allowlistId}`);

//   // 6. Walrus에 업로드
//   console.log(`\n📤 Uploading encrypted blob to Walrus...`);
//   const storageInfo = await storeBlob(encryptedData); // walrus에 encryptedData 업로드
//   const blobInfo = extractBlobInfo(storageInfo.info); // blobInfo 추출

//   console.log(`\n✅ Upload successful!`);
//   console.log(`📦 Status: ${blobInfo.status}`);
//   console.log(`📦 Blob ID: ${blobInfo.blobId}`);
//   console.log(`📅 End Epoch: ${blobInfo.endEpoch}`);
//   console.log(`🔗 ${blobInfo.suiRefType}: ${blobInfo.suiRef}`);
//   console.log(
//     `🔍 Walrus Aggregator URL: ${WALRUS_AGGREGATOR_URL}/v1/blobs/${blobInfo.blobId}`
//   );
//   console.log(
//     `🔍 SuiScan URL: https://suiscan.xyz/testnet/object/${blobInfo.suiRef}`
//   );

//   // 7. Allowlist에 publish
//   await publishToAllowlist(allowlistId, capId, blobInfo.blobId); // allowlist에 blob publish, 여기서 컨트랙트 레벨에 업로드된 블롭과 연결이 생김

//   // 8. 결과 저장
//   const outputDir = path.join(__dirname, "../tmp/walrus");
//   if (!fs.existsSync(outputDir)) {
//     fs.mkdirSync(outputDir, { recursive: true });
//   }

//   const saveResultsPath = path.join(
//     outputDir,
//     "upload_secret_key_results.json"
//   );
//   const uploadInfo = {
//     timestamp: new Date().toISOString(),
//     secretKeyPath,
//     allowlistId,
//     capId,
//     blobId: blobInfo.blobId,
//     encryptionId,
//     endEpoch: blobInfo.endEpoch,
//     status: blobInfo.status,
//     suiRefType: blobInfo.suiRefType,
//     suiRef: blobInfo.suiRef,
//     walrusAggregatorUrl: `${WALRUS_AGGREGATOR_URL}/v1/blobs/${blobInfo.blobId}`,
//     suiScanUrl: `https://suiscan.xyz/testnet/object/${blobInfo.suiRef}`,
//   };

//   fs.writeFileSync(saveResultsPath, JSON.stringify(uploadInfo, null, 2));
//   console.log(`\n💾 Upload info saved to: ${saveResultsPath}`);
//   console.log(
//     `\n✅ Successfully uploaded secret key and published to allowlist!`
//   );
//   console.log(`\n📋 Summary:`);
//   console.log(`   - Allowlist ID: ${allowlistId}`);
//   console.log(`   - Cap ID: ${capId}`);
//   console.log(`   - Blob ID: ${blobInfo.blobId}`);
//   console.log(`   - Encryption ID: ${encryptionId}`);
// }

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
