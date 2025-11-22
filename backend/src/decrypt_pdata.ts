import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromHex, toHex } from '@mysten/sui/utils';
import { SealClient, SessionKey } from '@mysten/seal';
import dotenv from 'dotenv';

dotenv.config();

// --- 환경 변수 체크 ---
if (!process.env.ORACLE_PRIVATE_KEY) {
    throw new Error("❌ ORACLE_PRIVATE_KEY environment variable missing");
}

const NETWORK = 'testnet';
const PACKAGE_ID = process.env.PDATA_PACKAGE_ID || '0xb2c7506fa0994a327bce64a8ab3c841c1ffc0057933ffad6f78d41d8f86a523b';
const MODULE_NAME = 'private_data';

// Seal 서버 설정 (setup_game.ts와 동일)
const serverObjectIds = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
];

const { secretKey } = decodeSuiPrivateKey(process.env.ORACLE_PRIVATE_KEY!);
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
 * 저장된 PrivateData 객체를 복호화하는 함수
 */
async function decryptPData(objectId: string, sessionKey?: Uint8Array) {
    console.log(`\n🔓 Decrypting PrivateData object...`);
    console.log(`📦 Object ID: ${objectId}`);
    
    try {
        // 1. PrivateData 객체 가져오기
        console.log(`\n📥 Fetching object from Sui...`);
        const objectDetails = await suiClient.getObject({
            id: objectId,
            options: { showContent: true }
        });
        
        if (!objectDetails.data?.content || !('fields' in objectDetails.data.content)) {
            throw new Error('Failed to get object details or invalid object type');
        }
        
        const fields = objectDetails.data.content.fields as Record<string, unknown>;
        const creator = fields.creator as string;
        const storedNonce = fields.nonce as number[];
        const storedData = fields.data as number[];
        
        console.log(`✅ Object fetched successfully`);
        console.log(`📋 Object Fields:`);
        console.log(`   - creator: ${creator}`);
        console.log(`   - nonce (hex): ${toHex(new Uint8Array(storedNonce))}`);
        console.log(`   - encrypted data length: ${storedData.length} bytes`);
        
        // 2. compute_key_id로 encryption ID 계산
        const nonceBytes = new Uint8Array(storedNonce);
        const keyId = computeKeyId(creator, nonceBytes);
        const encryptionId = toHex(keyId);
        
        console.log(`\n🔑 Computed Key ID (hex): ${encryptionId}`);
        
        // 3. 저장된 암호화된 데이터 가져오기
        const encryptedBytes = new Uint8Array(storedData);
        console.log(`📦 Encrypted data: ${encryptedBytes.length} bytes`);
        
        // 4. seal_approve 트랜잭션 생성
        console.log(`\n📝 Creating seal_approve transaction...`);
        const tx = new Transaction();
        
        tx.moveCall({
            target: `${PACKAGE_ID}::${MODULE_NAME}::seal_approve`,
            arguments: [
                tx.pure.vector("u8", Array.from(keyId)),
                tx.object(objectId),
            ]
        });
        
        // 5. 트랜잭션 바이트 생성 (onlyTransactionKind: true)
        console.log(`🔨 Building transaction bytes...`);
        const txBytes = await tx.build({ 
            client: suiClient, 
            onlyTransactionKind: true 
        });
        
        console.log(`✅ Transaction bytes created: ${txBytes.length} bytes`);
        
        // 6. Seal로 복호화
        console.log(`\n🔐 Decrypting with Seal...`);

        // SessionKey 생성
        const sessionKey = await SessionKey.create({
            address: keypair.toSuiAddress(),
            packageId: PACKAGE_ID,
            ttlMin: 10,
            suiClient,
        });
        
        // Personal message 가져오기 및 서명
        console.log(`📝 Signing personal message...`);
        const personalMessage = sessionKey.getPersonalMessage();
        const signature = await keypair.signPersonalMessage(personalMessage);
        
        // 서명을 SessionKey에 설정
        await sessionKey.setPersonalMessageSignature(signature.signature);
        console.log(`✅ Personal message signed`);
        
        // Seal로 복호화
        const decryptedData = await sealClient.decrypt({
            data: new Uint8Array(encryptedBytes),
            sessionKey,
            txBytes,
        });
        
        // 7. 복호화된 데이터 출력
        const decryptedText = new TextDecoder().decode(decryptedData);
        console.log(`\n✅ Decryption successful!`);
        console.log(`📄 Decrypted data: "${decryptedText}"`);
        console.log(`📊 Decrypted data length: ${decryptedData.length} bytes`);
        console.log(`🔑 Encryption ID used: ${encryptionId}`);
        
        return {
            decryptedData,
            decryptedText,
            encryptionId,
            objectId,
        };
        
    } catch (error) {
        console.error(`\n❌ Failed to decrypt:`, error);
        throw error;
    }
}

// 메인 실행
const OBJECT_ID = process.env.OBJECT_ID || "0x3c61b5bb1e5a621360751696680de2a799e20af319db10a2e829e9d640373580";

// sessionKey는 환경 변수나 명령줄 인자로 받을 수 있음
// 예: SESSION_KEY=0x1234... npm run decrypt-pdata
const sessionKeyHex = process.env.SESSION_KEY;
const sessionKey = sessionKeyHex ? fromHex(sessionKeyHex.startsWith('0x') ? sessionKeyHex.slice(2) : sessionKeyHex) : undefined;

decryptPData(OBJECT_ID, sessionKey).catch(console.error);

