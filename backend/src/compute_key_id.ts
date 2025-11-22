import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
// import { fromB64, toB64 } from '@mysten/sui/utils';

// 1. 설정 (Sui Client & Wallet)
const client = new SuiClient({ url: getFullnodeUrl('testnet') });
// 실제 개발시는 지갑 연동이나 환경변수에서 키를 가져옵니다.
const keypair = Ed25519Keypair.generate(); 
const PACKAGE_ID = '0xb2c7506fa0994a327bce64a8ab3c841c1ffc0057933ffad6f78d41d8f86a523b' // 배포한 Move 패키지 ID
const MODULE_NAME = 'private_data';

/**
 * 시나리오:
 * 1. 안전한 Nonce(난수) 생성
 * 2. (Off-chain) Seal 서비스를 이용해 데이터 암호화
 * 3. (On-chain) 암호화된 데이터와 Nonce를 Sui에 저장
 */
async function storeEncryptedData() {
    console.log(`User Address: ${keypair.toSuiAddress()}`);

    // --- Step 1: Nonce 생성 (임의의 바이트 배열) ---
    // Nonce는 같은 사용자가 여러 개의 데이터를 저장할 때 구분자 역할을 합니다.
    const nonceString = "unique_random_nonce_123";
    const nonceBytes = new TextEncoder().encode(nonceString);

    // --- Step 2: 데이터 암호화 (Off-chain 영역) ---
    const mySecretData = "This is my secret diary.";
    
    // [중요] 실제로는 Seal SDK나 TEE 노드의 API를 호출하는 부분입니다.
    // 여기서는 개념 설명을 위해 가상의 함수로 대체합니다.
    // Seal 서비스는 (UserAddress + Nonce)를 기반으로 암호화를 수행합니다.
    const encryptedDataBytes = await mockSealEncrypt(
        mySecretData, 
        keypair.toSuiAddress(), 
        nonceBytes
    );

    console.log("Data Encrypted. Preparing Transaction...");

    // --- Step 3: Sui 트랜잭션 생성 (TDD: Red -> Green) ---
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
    const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: {
            showEffects: true,
            showObjectChanges: true,
        },
    });

    console.log("Transaction Status:", result.effects?.status.status);
    
    // 생성된 객체 ID 확인 (PrivateData 객체)
    const createdObject = result.objectChanges?.find(
        (change) => change.type === 'created' && change.objectType.includes('PrivateData')
    );
    
    if (createdObject && 'objectId' in createdObject) {
        console.log("Stored PrivateData Object ID:", createdObject.objectId);
    }
}

// [Mock] Seal 암호화 서비스 시뮬레이션
// 실제로는 Seal SDK가 시스템의 Master Public Key를 사용하여 암호화합니다.
async function mockSealEncrypt(data: string, address: string, nonce: Uint8Array): Promise<Uint8Array> {
    // 실제 암호화 로직 대신 간단한 인코딩 반환
    console.log(`[Seal Service] Encrypting for KeyID derived from: ${address} + Nonce`);
    return new TextEncoder().encode("ENCRYPTED_" + data);
}

storeEncryptedData().catch(console.error);