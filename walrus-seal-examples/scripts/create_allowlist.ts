import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
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

const { secretKey } = decodeSuiPrivateKey(PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

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
 * Allowlist 생성 함수
 * CreateAllowlist.tsx의 createAllowlist 함수를 참고
 */
async function createAllowlist(name: string): Promise<string> {
    if (name === '') {
        throw new Error('Please enter a name for the allowlist');
    }

    console.log(`\n📝 Creating allowlist: "${name}"`);
    
    // Transaction 생성
    const tx = new Transaction();
    
    tx.moveCall({
        target: `${PACKAGE_ID}::allowlist::create_allowlist_entry`,
        arguments: [tx.pure.string(name)],
    });
    
    tx.setGasBudget(10000000);


    // 트랜잭션 빌드 및 서명
    console.log(`🔨 Building transaction...`);
    const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: {
            showRawEffects: true,
            showEffects: true,
            showEvents: true,
        },
    });

    console.log(`✅ Transaction executed successfully!`);
    console.log(`📋 Transaction Digest: ${result.digest}`);

    // 생성된 allowlist 객체 ID 추출
    // CreateAllowlist.tsx의 로직 참고:
    // const allowlistObject = result.effects?.created?.find(
    //   (item) => item.owner && typeof item.owner === 'object' && 'Shared' in item.owner,
    // );
    const createdObjects = result.effects?.created || [];
    const allowlistObject = createdObjects.find(
        (item) => {
            if (!item.owner) return false;
            if (typeof item.owner === 'object' && 'Shared' in item.owner) {
                return true;
            }
            return false;
        }
    );

    const allowlistId = allowlistObject?.reference?.objectId;

    if (!allowlistId) {
        console.warn(`⚠️  Could not find allowlist object ID in transaction result`);
        console.log(`📋 Created objects:`, JSON.stringify(createdObjects, null, 2));
        throw new Error('Failed to extract allowlist object ID from transaction result');
    }

    console.log(`\n✅ Allowlist created successfully!`);
    console.log(`📦 Allowlist ID: ${allowlistId}`);
    console.log(`🔗 SuiScan URL: https://suiscan.xyz/testnet/object/${allowlistId}`);

    return allowlistId;
}

/**
 * 생성된 Cap 객체 ID 찾기
 */
async function findCapForAllowlist(allowlistId: string): Promise<string | null> {
    console.log(`\n🔍 Looking for Cap object for allowlist: ${allowlistId}`);
    
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

    const matchingCap = caps.find((cap) => cap.allowlist_id === allowlistId);
    
    if (matchingCap) {
        console.log(`✅ Found Cap ID: ${matchingCap.id}`);
        return matchingCap.id;
    }

    console.log(`⚠️  Cap object not found yet (may need to wait for indexer)`);
    return null;
}

/**
 * 메인 함수
 */
async function main() {
    console.log(`\n🚀 Create Allowlist`);
    console.log(`📝 User Address: ${keypair.toSuiAddress()}`);
    console.log(`📦 Package ID: ${PACKAGE_ID}`);
    console.log(`🌐 Network: ${NETWORK}`);

    // 1. 명령줄 인자에서 allowlist 이름 확인
    let allowlistName: string | undefined;
    
    if (process.argv.length > 2) {
        allowlistName = process.argv[2];
    } else {
        // 사용자 입력 요청
        console.log('\n📦 Allowlist 생성');
        console.log('='.repeat(50));
        const input = await getUserInput('\n📝 Allowlist 이름을 입력하세요: ');
        
        if (!input) {
            console.error('❌ Allowlist 이름이 입력되지 않았습니다.');
            process.exit(1);
        }
        
        allowlistName = input.trim();
    }

    if (!allowlistName) {
        console.error('❌ Allowlist 이름이 없습니다.');
        process.exit(1);
    }

    try {
        // 2. Allowlist 생성
        const allowlistId = await createAllowlist(allowlistName);

        // 3. Cap 객체 찾기 (약간의 지연 후)
        console.log(`\n⏳ Waiting for indexer to update...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const capId = await findCapForAllowlist(allowlistId);

        // 4. 결과 저장
        const outputDir = path.join(__dirname, '../tmp/walrus');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const resultsPath = path.join(outputDir, 'allowlist_results.json');
        const allowlistInfo = {
            timestamp: new Date().toISOString(),
            allowlistName,
            allowlistId,
            capId: capId || 'Not found',
            owner: keypair.toSuiAddress(),
            packageId: PACKAGE_ID,
            network: NETWORK,
            suiScanUrl: `https://suiscan.xyz/testnet/object/${allowlistId}`,
        };
        
        // 기존 결과가 있으면 배열로 추가, 없으면 새로 생성
        let allResults: any[] = [];
        if (fs.existsSync(resultsPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
                allResults = Array.isArray(existing) ? existing : [existing];
            } catch (e) {
                // 파일이 손상되었으면 새로 시작
                allResults = [];
            }
        }
        
        allResults.push(allowlistInfo);
        fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
        
        console.log(`\n💾 Allowlist info saved to: ${resultsPath}`);
        console.log(`\n📋 Summary:`);
        console.log(`   - Allowlist Name: ${allowlistName}`);
        console.log(`   - Allowlist ID: ${allowlistId}`);
        console.log(`   - Cap ID: ${capId || 'Not found (check later)'}`);
        console.log(`   - Owner: ${keypair.toSuiAddress()}`);
        
        console.log(`\n💡 To check this allowlist, run:`);
        console.log(`   npm run check-allowlist ${allowlistId}`);

    } catch (error) {
        console.error(`\n❌ Failed to create allowlist:`, error);
        throw error;
    }
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});

