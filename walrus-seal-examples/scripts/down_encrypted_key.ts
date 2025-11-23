import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
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

const { secretKey } = decodeSuiPrivateKey(PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

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
 * 메인 함수
 */
async function main() {
    console.log(`\n📥 Download Encrypted Key from Walrus`);
    console.log(`📝 User Address: ${keypair.toSuiAddress()}`);
    console.log(`📦 Package ID: ${PACKAGE_ID}`);
    console.log(`🌐 Network: ${NETWORK}`);

    // 1. 명령줄 인자에서 blob ID 확인
    let blobId: string | undefined;
    
    if (process.argv.length > 2) {
        blobId = process.argv[2];
    } else {
        // 사용자 입력 요청
        console.log('\n📦 Encrypted Key 다운로드');
        console.log('='.repeat(50));

        // 1-1. 모든 Cap 객체 가져오기
        const allCaps = await getAllCaps();
        
        if (allCaps.length === 0) {
            console.log(`\n⚠️  No Cap objects found for address: ${keypair.toSuiAddress()}`);
            console.log(`💡 You need to create an allowlist first.`);
            console.log(`   Run: npm run create-allowlist`);
            process.exit(1);
        }

        // 1-2. Allowlist 선택
        let selectedAllowlistId: string;
        if (allCaps.length === 1) {
            selectedAllowlistId = allCaps[0].allowlist_id;
            console.log(`\n✅ Using the only available allowlist:`);
            console.log(`   Allowlist ID: ${selectedAllowlistId}`);
        } else {
            console.log(`\n📋 Found ${allCaps.length} allowlist(s). Please select one:`);
            console.log('='.repeat(50));
            
            const capInfos = await Promise.all(
                allCaps.map(async (cap) => {
                    try {
                        const allowlist = await getAllowlist(cap.allowlist_id);
                        return {
                            cap,
                            allowlistName: allowlist.name,
                            memberCount: allowlist.list.length,
                        };
                    } catch (error) {
                        return {
                            cap,
                            allowlistName: 'N/A',
                            memberCount: 0,
                        };
                    }
                })
            );

            capInfos.forEach((info, index) => {
                console.log(`\n${index + 1}. Allowlist: ${info.allowlistName}`);
                console.log(`   Allowlist ID: ${info.cap.allowlist_id}`);
                console.log(`   Cap ID: ${info.cap.id}`);
                console.log(`   Members: ${info.memberCount} address(es)`);
            });

            const input = await getUserInput(`\n🔢 Select Allowlist (1-${allCaps.length}): `);
            const selectedIndex = parseInt(input.trim()) - 1;

            if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= allCaps.length) {
                console.error(`❌ Invalid selection. Please choose a number between 1 and ${allCaps.length}.`);
                process.exit(1);
            }

            selectedAllowlistId = allCaps[selectedIndex].allowlist_id;
            console.log(`\n✅ Selected: ${selectedAllowlistId}`);
        }

        // 1-3. 선택한 allowlist의 blob ID들 가져오기
        console.log(`\n🔍 Loading blob IDs from allowlist...`);
        const blobIds = await getBlobIdsFromAllowlist(selectedAllowlistId);

        if (blobIds.length === 0) {
            console.log(`\n⚠️  No blob IDs found in this allowlist.`);
            console.log(`💡 You may need to upload a secret key first.`);
            console.log(`   Run: npm run upload-secret-key`);
            process.exit(1);
        }

        // 1-4. Blob ID 선택
        console.log(`\n📋 Found ${blobIds.length} blob ID(s) in this allowlist:`);
        console.log('='.repeat(50));
        blobIds.forEach((id, index) => {
            console.log(`${index + 1}. ${id}`);
        });

        const blobInput = await getUserInput(`\n🔢 Select Blob ID (1-${blobIds.length}): `);
        const selectedBlobIndex = parseInt(blobInput.trim()) - 1;

        if (isNaN(selectedBlobIndex) || selectedBlobIndex < 0 || selectedBlobIndex >= blobIds.length) {
            console.error(`❌ Invalid selection. Please choose a number between 1 and ${blobIds.length}.`);
            process.exit(1);
        }

        blobId = blobIds[selectedBlobIndex];
        console.log(`\n✅ Selected Blob ID: ${blobId}`);
    }

    if (!blobId) {
        console.error('❌ Blob ID가 없습니다.');
        process.exit(1);
    }

    console.log(`\n📦 Blob ID: ${blobId}`);

    try {
        // 2. Blob 다운로드
        console.log(`\n📥 Downloading encrypted blob from Walrus...`);
        const downloadResult = await downloadBlobFromWalrus(blobId);
        
        if (!downloadResult) {
            const errorMsg =
                'Cannot retrieve file from Walrus aggregators. File uploaded more than 1 epoch ago may have been deleted.';
            console.error(`\n❌ ${errorMsg}`);
            process.exit(1);
        }
        
        console.log(`✅ Downloaded blob: ${downloadResult.byteLength} bytes`);

        // 3. 암호화된 데이터 저장
        const outputDir = path.join(__dirname, '../tmp/walrus/encrypted');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, `encrypted_${blobId.slice(0, 8)}.bin`);
        fs.writeFileSync(outputPath, Buffer.from(downloadResult));
        
        console.log(`\n✅ Download successful!`);
        console.log(`📄 Encrypted data saved to: ${outputPath}`);
        console.log(`📊 File size: ${downloadResult.byteLength} bytes`);

    } catch (error) {
        console.error(`\n❌ Failed to download:`, error);
        throw error;
    }
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});

