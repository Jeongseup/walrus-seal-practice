import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromHex, toHex } from '@mysten/sui/utils';
import { SealClient, SessionKey, NoAccessError, EncryptedObject } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import fs from 'fs';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.public first (public variables)
dotenv.config({ path: path.join(__dirname, '../.env.public') });

// Then load .env (private variables, will override .env.public if same key exists)
dotenv.config({ path: path.join(__dirname, '../.env') });

// --- 환경 변수 체크 ---
if (!process.env.PRIVATE_KEY) {
    throw new Error("❌ PRIVATE_KEY environment variable missing");
}
if (!process.env.PACKAGE_ID) {
    throw new Error("❌ PACKAGE_ID environment variable missing");
}

const NETWORK = 'testnet';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PACKAGE_ID = process.env.PACKAGE_ID;
const TTL_MIN = 10;

// Seal 서버 설정
const serverObjectIds = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
];

const { secretKey } = decodeSuiPrivateKey(PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

// SealClient 초기화
const sealClient = new SealClient({
    suiClient,
    serverConfigs: serverObjectIds.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});

// Walrus Aggregator URLs
const WALRUS_AGGREGATOR_URLS = [
    'https://aggregator.walrus-testnet.walrus.space',
];

/**
 * 사용자로부터 입력받는 함수
 */
function getUserInput(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * MoveCall 생성자 타입
 */
type MoveCallConstructor = (tx: Transaction, id: string) => void;

/**
 * constructMoveCall 함수 (제공된 코드 참고)
 */
function constructMoveCall(packageId: string, allowlistId: string): MoveCallConstructor {
    return (tx: Transaction, id: string) => {
        tx.moveCall({
            target: `${packageId}::allowlist::seal_approve`,
            arguments: [tx.pure.vector('u8', fromHex(id)), tx.object(allowlistId)],
        });
    };
}

/**
 * 현재 계정이 소유한 모든 Cap 객체들을 가져옴
 */
async function getAllCaps(): Promise<Array<{ id: string; allowlist_id: string }>> {
    console.log(`\n🔍 Loading all Cap objects for address: ${keypair.toSuiAddress()}`);
    
    const res = await suiClient.getOwnedObjects({
        owner: keypair.toSuiAddress(),
        options: {
            showContent: true,
            showType: true,
        },
        filter: {
            StructType: `${PACKAGE_ID}::allowlist::Cap`,
        },
    });

    const caps = res.data
        .map((obj) => {
            if (!obj.data?.content || typeof obj.data.content !== 'object' || !('fields' in obj.data.content)) {
                return null;
            }
            const fields = (obj.data.content as { fields: any }).fields;
            return {
                id: fields?.id?.id || fields?.id,
                allowlist_id: fields?.allowlist_id || fields?.allowlist_id?.id,
            };
        })
        .filter((item): item is { id: string; allowlist_id: string } => 
            item !== null && item.id && item.allowlist_id
        );

    console.log(`✅ Found ${caps.length} Cap object(s)`);
    return caps;
}

/**
 * Allowlist 객체를 가져옴
 */
async function getAllowlist(allowlistId: string) {
    try {
        const allowlist = await suiClient.getObject({
            id: allowlistId,
            options: { showContent: true },
        });

        if (!allowlist.data?.content || typeof allowlist.data.content !== 'object' || !('fields' in allowlist.data.content)) {
            throw new Error('Invalid allowlist object');
        }

        const fields = (allowlist.data.content as { fields: any }).fields || {};
        
        return {
            id: allowlistId,
            name: fields.name || 'N/A',
            list: fields.list || [],
        };
    } catch (error) {
        console.error(`❌ Failed to load allowlist: ${error}`);
        throw error;
    }
}

/**
 * Allowlist의 dynamic field에서 blob ID들을 가져옴
 */
async function getBlobIdsFromAllowlist(allowlistId: string): Promise<string[]> {
    try {
        const dynamicFields = await suiClient.getDynamicFields({
            parentId: allowlistId,
        });

        // dynamic field의 name이 blob_id (String 타입)
        const blobIds = dynamicFields.data
            .map((field) => {
                // field.name의 타입이 string인지 확인
                if (typeof field.name === 'string') {
                    return field.name;
                }
                // field.name이 객체인 경우 (예: { type: 'String', value: '...' })
                if (field.name && typeof field.name === 'object' && 'value' in field.name) {
                    return field.name.value as string;
                }
                return null;
            })
            .filter((id): id is string => id !== null);

        return blobIds;
    } catch (error) {
        console.error(`⚠️ Failed to get dynamic fields for allowlist ${allowlistId}:`, error);
        return [];
    }
}

/**
 * Walrus에서 blob 다운로드
 * 여러 aggregator를 시도하여 다운로드
 */
async function downloadBlobFromWalrus(blobId: string): Promise<ArrayBuffer | null> {
    const aggregators = WALRUS_AGGREGATOR_URLS;
    
    // 여러 aggregator를 시도
    for (const aggregator of aggregators) {
        const aggregatorUrl = `${aggregator}/v1/blobs/${blobId}`;
        
        console.log(`📥 Trying to download from: ${aggregator}`);
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10초 타임아웃
            
            const response = await fetch(aggregatorUrl, { signal: controller.signal });
            clearTimeout(timeout);
            
            if (response.ok) {
                console.log(`✅ Successfully downloaded from: ${aggregator}`);
                return await response.arrayBuffer();
            } else {
                console.warn(`⚠️ Failed to download from ${aggregator}: HTTP ${response.status}`);
            }
        } catch (err) {
            console.warn(`⚠️ Error downloading from ${aggregator}:`, err);
        }
    }
    
    return null;
}

/**
 * 다운로드 및 복호화 함수 (제공된 코드 참고)
 */
async function downloadAndDecrypt(
    blobIds: string[],
    sessionKey: SessionKey,
    suiClient: SuiClient,
    sealClient: SealClient,
    moveCallConstructor: MoveCallConstructor,
): Promise<Uint8Array[]> {
    console.log(`\n🔓 Downloading and decrypting ${blobIds.length} blob(s)...`);

    // 1. 모든 파일을 병렬로 다운로드 (에러 무시)
    const downloadResults = await Promise.all(
        blobIds.map(async (blobId) => {
            try {
                return await downloadBlobFromWalrus(blobId);
            } catch (err) {
                console.error(`❌ Blob ${blobId} cannot be retrieved from Walrus`, err);
                return null;
            }
        }),
    );

    // 실패한 다운로드 필터링
    const validDownloads = downloadResults.filter((result): result is ArrayBuffer => result !== null);

    console.log(`✅ Valid downloads count: ${validDownloads.length}`);

    if (validDownloads.length === 0) {
        const errorMsg =
            'Cannot retrieve files from Walrus aggregators. Files uploaded more than 1 epoch ago may have been deleted.';
        throw new Error(errorMsg);
    }

    // 2. 배치로 키 가져오기 (<=10개씩)
    console.log(`\n🔑 Fetching decryption keys...`);
    for (let i = 0; i < validDownloads.length; i += 10) {
        const batch = validDownloads.slice(i, i + 10);
        // 원본 코드처럼 EncryptedObject.parse의 id를 그대로 사용
        const ids = batch.map((enc) => EncryptedObject.parse(new Uint8Array(enc)).id);

        const tx = new Transaction();
        // moveCallConstructor는 string을 기대하므로 id를 string으로 변환
        ids.forEach((id) => {
            const idStr = typeof id === 'string' ? id : toHex(id);
            moveCallConstructor(tx, idStr);
        });
        // function constructMoveCall(packageId: string, allowlistId: string): MoveCallConstructor {
        //     return (tx: Transaction, id: string) => {
        //         tx.moveCall({
        //             target: `${packageId}::allowlist::seal_approve`,
        //             arguments: [tx.pure.vector('u8', fromHex(id)), tx.object(allowlistId)],
        //         });
        //     };
        // }

        const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
        console.log(`🔑 txBytes: ${txBytes}`);

        try {
            // 원본 코드처럼 ids를 그대로 전달 (fetchKeys가 적절한 형식으로 처리)
            await sealClient.fetchKeys({ 
                ids, 
                txBytes, 
                sessionKey, 
                threshold: 2 
            });
            console.log(`✅ Fetched keys for batch ${Math.floor(i / 10) + 1}`);
        } catch (err) {
            console.error(`❌ Error fetching keys:`, err);
            const errorMsg =
                err instanceof NoAccessError
                    ? 'No access to decryption keys'
                    : 'Unable to fetch decryption keys';
            throw new Error(errorMsg);
        }
    }


    // 3. 파일들을 순차적으로 복호화
    console.log(`\n🔐 Decrypting files...`);
    const decryptedFiles: Uint8Array[] = [];

    for (const encryptedData of validDownloads) {
        // 원본 코드처럼 EncryptedObject.parse의 id를 그대로 사용
        const fullId = EncryptedObject.parse(new Uint8Array(encryptedData)).id;
        
        const tx = new Transaction();
        // moveCallConstructor는 string을 기대하므로 id를 string으로 변환
        const fullIdStr = typeof fullId === 'string' ? fullId : toHex(fullId);
        moveCallConstructor(tx, fullIdStr);

        const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });

        try {
            const decryptedFile = await sealClient.decrypt({
                data: new Uint8Array(encryptedData),
                sessionKey,
                txBytes,
            });

            decryptedFiles.push(decryptedFile);
            console.log(`✅ Decrypted file ${decryptedFiles.length}/${validDownloads.length}`);
        } catch (err) {
            console.error(`❌ Error decrypting file:`, err);
            const errorMsg =
                err instanceof NoAccessError
                    ? 'No access to decryption keys'
                    : 'Unable to decrypt file';
            throw new Error(errorMsg);
        }
    }

    return decryptedFiles;
}

/**
 * 메인 함수
 */
async function main() {
    console.log(`\n🔓 Download and Decrypt Key from Walrus`);
    console.log(`📝 User Address: ${keypair.toSuiAddress()}`);
    console.log(`📦 Package ID: ${PACKAGE_ID}`);
    console.log(`🌐 Network: ${NETWORK}`);

    // 1. 명령줄 인자 확인
    let blobId: string = 'VP8IH95U0mM8pQa_dck9uQMvoSdTa0a1GvnbeCsYiKM';
    let allowlistId: string = '0x9a4e969eb88da1c1463142044899b31309af4ce2fc1fabc0ae4fdccf046f43e6';

    if (!blobId || !allowlistId) {
        console.error('❌ 필수 인자가 누락되었습니다.');
        console.log('\n💡 Usage:');
        console.log('   npm run down-and-decrypted-key <blob_id> <allowlist_id>');
        console.log('   또는 대화형 모드로 실행');
        process.exit(1);
    }

    console.log(`\n📦 Blob ID: ${blobId}`);
    console.log(`📋 Allowlist ID: ${allowlistId}`);

    try {
        // 2. SessionKey 생성 및 서명
        console.log(`\n🔑 Creating SessionKey...`);
        const sessionKey = await SessionKey.create({
            address: keypair.toSuiAddress(),
            packageId: PACKAGE_ID,
            ttlMin: TTL_MIN,
            suiClient,
        });
        
        const personalMessage = sessionKey.getPersonalMessage();
        // NOTE: 이 부분은 frontend에서 처리해야함. '
        // ref; https://github.com/MystenLabs/seal/blob/main/examples/frontend/src/AllowlistView.tsx#L4
        const signature = await keypair.signPersonalMessage(personalMessage);
        await sessionKey.setPersonalMessageSignature(signature.signature);
        console.log(`✅ SessionKey created and signed`);

        // 3. MoveCall 생성자 생성
        const moveCallConstructor = constructMoveCall(PACKAGE_ID, allowlistId);

        // 4. 다운로드 및 복호화
        const decryptedFiles = await downloadAndDecrypt(
            [blobId],
            sessionKey,
            suiClient,
            sealClient,
            moveCallConstructor,
        );

        // 5. 복호화된 데이터 저장
        const outputDir = path.join(__dirname, '../tmp/walrus/decrypted');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        decryptedFiles.forEach((decryptedData, index) => {
            // Secret key는 hex 문자열로 저장
            const decryptedHex = Buffer.from(decryptedData).toString('hex');
            const outputPath = path.join(outputDir, `decrypted_${blobId.slice(0, 8)}_${index}.hex`);
            fs.writeFileSync(outputPath, decryptedHex);
            
            console.log(`\n✅ Decryption successful!`);
            console.log(`📄 Decrypted data:`);
            console.log(`   Hex: ${decryptedHex.slice(0, 32)}...${decryptedHex.slice(-32)}`);
            console.log(`   Size: ${decryptedData.length} bytes`);
            console.log(`   Saved to: ${outputPath}`);
        });

    } catch (error: any) {
        console.error(`\n❌ Failed to download and decrypt:`, error.message || error);
        if (error.message?.includes('No access')) {
            console.log(`\n💡 You may not have access to this allowlist. Make sure your address is in the allowlist.`);
        }
        throw error;
    }
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});

