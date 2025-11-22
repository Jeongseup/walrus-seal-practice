import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromHex, toHex } from '@mysten/sui/utils';
import { SealClient } from '@mysten/seal';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// --- 환경 변수 체크 ---
if (!process.env.ORACLE_PRIVATE_KEY) {
    throw new Error("❌ ORACLE_PRIVATE_KEY environment variable missing");
}

const NETWORK = 'testnet';
const PACKAGE_ID = process.env.PDATA_PACKAGE_ID || '0xb2c7506fa0994a327bce64a8ab3c841c1ffc0057933ffad6f78d41d8f86a523b';
const MODULE_NAME = 'private_data';

// Seal 서버 설정 (setup_game.ts와 동일)
// ref; https://seal-docs.wal.app/Pricing/#verified-key-servers
const serverObjectIds = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
];

const { secretKey } = decodeSuiPrivateKey(process.env.ORACLE_PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const baseSuiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

// SealClient 초기화 
const sealClient = new SealClient({
    suiClient: baseSuiClient,
    serverConfigs: serverObjectIds.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});

/**
 * Move의 compute_key_id 함수를 TypeScript로 재현
 * 
 * Move 코드:
 * fun compute_key_id(sender: address, nonce: vector<u8>): vector<u8> {
 *     let mut blob = sender.to_bytes();
 *     blob.append(nonce);
 *     blob
 * }
 */
function computeKeyId(sender: string, nonce: Uint8Array): Uint8Array {
    const senderHex = sender.startsWith('0x') ? sender.slice(2) : sender;
    const senderBytes = fromHex(senderHex);
    
    const keyId = new Uint8Array(senderBytes.length + nonce.length);
    keyId.set(senderBytes, 0);
    keyId.set(nonce, senderBytes.length);
    
    return keyId;
}

/**
 * 시나리오:
 * 1. 안전한 Nonce(난수) 생성
 * 2. compute_key_id를 사용하여 encryption ID 생성
 * 3. (Off-chain) Seal 서비스를 이용해 데이터 암호화
 * 4. (On-chain) 암호화된 데이터와 Nonce를 Sui에 저장
 */
async function storeEncryptedData() {
    console.log(`\n🔑 Storing Encrypted Data with Seal...`);
    console.log(`📝 User Address: ${keypair.toSuiAddress()}`);
    console.log(`📦 Package ID: ${PACKAGE_ID}`);

    // --- Step 1: Nonce 생성 (임의의 바이트 배열) ---
    // Nonce는 같은 사용자가 여러 개의 데이터를 저장할 때 구분자 역할을 합니다.
    const nonce = crypto.getRandomValues(new Uint8Array(5));
    const nonceBytes = Array.from(nonce);
    console.log(`\n📌 Nonce (hex): ${toHex(nonce)}`);

    // --- Step 2: compute_key_id를 사용하여 encryption ID 생성 ---
    // Move의 compute_key_id(sender, nonce) = [sender bytes][nonce]
    const keyId = computeKeyId(keypair.toSuiAddress(), nonce);
    const encryptionId = toHex(keyId);
    console.log(`📌 Key ID (hex): ${encryptionId}`);

    // --- Step 3: 데이터 암호화 (Off-chain 영역) ---
    const mySecretData = "This is my secret diary.";
    const dataBytes = new TextEncoder().encode(mySecretData);
    
    console.log(`\n🔐 Encrypting data with Seal...`);
    // 실제 Seal SDK를 사용하여 암호화
    const { encryptedObject: encryptedDataBytes } = await sealClient.encrypt({
        threshold: 2,
        packageId: PACKAGE_ID,
        id: encryptionId,
        data: dataBytes,
    });
    
    console.log(`✅ Data encrypted! Encrypted data length: ${encryptedDataBytes.length} bytes`);

    // --- Step 4: Sui 트랜잭션 생성 ---
    console.log(`\n📝 Preparing transaction...`);
    const tx = new Transaction();

    // Move의 store_entry 함수 호출
    // fun store_entry(nonce: vector<u8>, data: vector<u8>, ctx: &mut TxContext)
    tx.moveCall({
        target: `${PACKAGE_ID}::${MODULE_NAME}::store_entry`,
        arguments: [
            tx.pure.vector('u8', Array.from(nonceBytes)),         // nonce
            tx.pure.vector('u8', Array.from(encryptedDataBytes)), // encrypted data
        ],
    });

    // --- Step 4: 트랜잭션 서명 및 전송 ---
    console.log(`\n🔗 Submitting transaction to Sui...`);
    const result = await baseSuiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: {
            showEffects: true,
            showObjectChanges: true,
        },
    });

    console.log(`✅ Transaction executed! Digest: ${result.digest}`);
    console.log(`📊 Transaction Status: ${result.effects?.status.status}`);
    
    // 생성된 객체 ID 확인 (PrivateData 객체)
    const createdObject = result.objectChanges?.find(
        (change) => change.type === 'created' && change.objectType.includes('PrivateData')
    );
    
    if (createdObject && 'objectId' in createdObject) {
        console.log(`\n📦 Stored PrivateData Object ID: ${createdObject.objectId}`);
        console.log(`🔍 View on SuiScan: https://suiscan.xyz/testnet/object/${createdObject.objectId}`);
    }
    
    console.log(`\n✅ Process completed!\n`);
}

storeEncryptedData().catch(console.error);