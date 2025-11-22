import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromHex, toHex } from '@mysten/sui/utils';
import { SealClient } from '@mysten/seal';
import { walrus, WalrusFile } from '@mysten/walrus';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import sharp from 'sharp'; // 이미지 처리
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();

// --- 환경 변수 체크 ---
if (!process.env.ORACLE_PRIVATE_KEY || !process.env.PACKAGE_ID) {
    throw new Error("❌ Environment variables missing");
}

const NETWORK = 'testnet';
const PACKAGE_ID = process.env.PACKAGE_ID!;
const MODULE_NAME = 'mosaic';
const WALRUS_PUBLISHER = process.env.WALRUS_PUBLISHER_URL || "https://publisher.walrus-testnet.walrus.space";
const NUM_EPOCH = 1;

// Seal 서버 설정 (제공된 코드에서 가져옴)
const serverObjectIds = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
];

const { secretKey } = decodeSuiPrivateKey(process.env.ORACLE_PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const baseSuiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });
const suiClient = baseSuiClient.$extend(walrus({ network: NETWORK as 'testnet' | 'mainnet' }));

// SealClient 초기화 (원본 SuiClient 사용)
const sealClient = new SealClient({
    suiClient: baseSuiClient,
    serverConfigs: serverObjectIds.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});

// ==========================================
// 🛠️ Helper Functions
// ==========================================

// 1. AES-GCM 암호화 (타일 이미지용)
function encryptWithAes(buffer: Buffer): { encryptedData: Buffer; keyHex: string } {
    const key = crypto.randomBytes(32); // 256-bit Key
    const iv = crypto.randomBytes(12);  // 96-bit IV (GCM standard)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    // 저장 포맷: [IV(12)] + [Tag(16)] + [EncryptedData(...)]
    const finalBuffer = Buffer.concat([iv, tag, encrypted]);
    
    return {
        encryptedData: finalBuffer,
        keyHex: key.toString('hex')
    };
}

// 2. Seal로 데이터 암호화 (AES 키용)
async function encryptWithSeal(data: Uint8Array, id: string): Promise<Uint8Array> {
    const { encryptedObject } = await sealClient.encrypt({
        threshold: 2,
        packageId: PACKAGE_ID,
        id,
        data,
    });
    return encryptedObject;
}

// 2. Walrus 업로드 (Walrus SDK 사용)
async function uploadFilesToWalrus(
    files: Array<{ data: Uint8Array; identifier: string }>,
    saveResultsPath?: string
): Promise<{ blobIds: string[]; results: any[] }> {
    const walrusFiles = files.map(({ data, identifier }) => 
        WalrusFile.from({
            contents: data,
            identifier,
        })
    );

    const results = await suiClient.walrus.writeFiles({
        files: walrusFiles,
        epochs: NUM_EPOCH,
        deletable: true,
        signer: keypair,
    });

    // 결과에서 blobId 추출 (다양한 응답 형식 지원)
    const blobIds = results.map((result: any) => {
        // 형식 1: 직접 blobId가 있는 경우
        if (result.blobId) {
            return result.blobId;
        }
        // 형식 2: newlyCreated 구조
        if (result.newlyCreated) {
            return result.newlyCreated.blobObject?.blobId || result.newlyCreated.blobId;
        }
        // 형식 3: alreadyCertified 구조
        if (result.alreadyCertified) {
            return result.alreadyCertified.blobId;
        }
        // 형식 4: blobObject 안에 blobId가 있는 경우
        if (result.blobObject?.blobId) {
            return result.blobObject.blobId;
        }
        // 형식 5: blobObject 안에 blob_id가 있는 경우 (문자열)
        if (result.blobObject?.blob_id) {
            return result.blobObject.blob_id;
        }
        // 디버깅을 위해 전체 응답 출력
        console.warn('⚠️ Unexpected response format:', JSON.stringify(result, null, 2));
        throw new Error(`Unknown Walrus response format: ${JSON.stringify(result)}`);
    });

    // 결과 저장
    if (saveResultsPath) {
        const uploadInfo = {
            timestamp: new Date().toISOString(),
            files: files.map((f, idx) => ({
                identifier: f.identifier,
                blobId: blobIds[idx],
                walrusUrl: `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${blobIds[idx]}`,
                result: results[idx],
                // 복호화에 필요한 정보 추가
                encryptionId: (f as any).encryptionId, // 암호화 시 사용한 id
            })),
        };
        fs.writeFileSync(saveResultsPath, JSON.stringify(uploadInfo, null, 2));
        console.log(`📝 Upload results saved to: ${saveResultsPath}`);
    }

    return { blobIds, results };
}

// ==========================================
// 🎮 Main Logic
// ==========================================
async function createGame() {
    console.log(`\n🚀 Starting Game Setup... User: ${keypair.toSuiAddress()}`);
    
    // 타임스탬프 기반 디렉토리 생성 (덮어쓰기 방지)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -1); // ISO 형식을 파일명에 사용 가능한 형식으로 변환
    const timestampDir = `testnet-${timestamp}`;
    const tmpDir = path.join('tmp', timestampDir);
    const tilesDir = path.join(tmpDir, 'tiles');
    const encryptedDir = path.join(tmpDir, 'encrypted');
    const manifestEncryptedDir = path.join(tmpDir, 'manifest_encrypted');
    
    [tmpDir, tilesDir, encryptedDir, manifestEncryptedDir].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
    console.log(`📁 Created timestamped directory: ${tmpDir}/`);
    
    const imagePath = 'sui.png';
    if (!fs.existsSync(imagePath)) {
        throw new Error(`❌ Image file not found: ${imagePath}. Please place 'sui.png' in backend root.`);
    }

    // 1. 이미지 로드 및 메타데이터 확인
    const image = sharp(imagePath);
    const metadata = await image.metadata();
    const width = metadata.width!;
    const height = metadata.height!;
    console.log(`📸 Image Loaded: ${width}x${height}`);
    console.log(`📸 Image Metadata:`, {
        format: metadata.format,
        width: metadata.width,
        height: metadata.height
    });

    // 1x1 그리드 계산 (테스트용)
    const rows = 10;
    const cols = 10;
    const tileW = Math.floor(width / cols);
    const tileH = Math.floor(height / rows);
    const totalTiles = rows * cols;

    // Step 1: 모든 타일을 먼저 자르기 (병렬 처리)
    console.log(`🔪 Step 1/3: Slicing ${totalTiles} tiles...`);
    const tileBuffers = await Promise.all(
        Array.from({ length: totalTiles }, async (_, idx) => {
            const r = Math.floor(idx / cols);
            const c = idx % cols;
            const tileBuffer = await sharp(imagePath)
                .extract({ left: c * tileW, top: r * tileH, width: tileW, height: tileH })
                .toFormat('png')
                .toBuffer();
            
            // tmp/tiles/ 에 저장
            const tilePath = path.join(tilesDir, `tile_${idx}.png`);
            fs.writeFileSync(tilePath, tileBuffer);
            
            return { idx, buffer: tileBuffer };
        })
    );
    console.log(`✅ All ${totalTiles} tiles sliced! Saved to: ${tilesDir}/`);

    // Step 2: 모든 타일을 AES로 암호화하고, AES 키를 Seal로 암호화하기 (병렬 처리)
    console.log(`🔐 Step 2/4: Encrypting ${totalTiles} tiles with AES and encrypting AES keys with Seal...`);
    const packageIdHex = PACKAGE_ID.startsWith('0x') ? PACKAGE_ID.slice(2) : PACKAGE_ID;
    const policyObjectBytes = fromHex(packageIdHex);
    
    const encryptedTiles = await Promise.all(
        tileBuffers.map(async ({ idx, buffer }) => {
            // 1. AES로 타일 암호화
            const { encryptedData: aesEncryptedTile, keyHex: aesKeyHex } = encryptWithAes(buffer);
            
            // 2. AES 키를 Seal로 암호화
            const nonce = crypto.getRandomValues(new Uint8Array(5));
            const encryptionId = toHex(new Uint8Array([...policyObjectBytes, ...nonce]));
            const aesKeyBytes = new Uint8Array(Buffer.from(aesKeyHex, 'hex'));
            const sealEncryptedAesKey = await encryptWithSeal(aesKeyBytes, encryptionId);
            
            // tmp/encrypted/ 에 AES 암호화된 타일 저장
            const encryptedPath = path.join(encryptedDir, `tile_${idx}.encrypted`);
            fs.writeFileSync(encryptedPath, aesEncryptedTile);
            
            return { 
                idx, 
                encryptedTile: aesEncryptedTile, // AES 암호화된 타일 (Walrus 업로드용)
                sealEncryptedAesKey, // Seal 암호화된 AES 키 (체인 저장용)
                encryptionId // Seal 복호화에 필요한 ID
            };
        })
    );
    console.log(`✅ All ${totalTiles} tiles encrypted with AES! AES keys encrypted with Seal! Saved to: ${encryptedDir}/`);

    // Step 3: 모든 타일을 한 번에 업로드하기 (Walrus SDK 사용)
    console.log(`📤 Step 3/4: Uploading ${totalTiles} AES-encrypted tiles to Walrus...`);
    const filesToUpload = encryptedTiles.map(({ idx, encryptedTile, encryptionId }) => ({
        data: encryptedTile, // AES 암호화된 타일
        identifier: `tile_${idx}.png`,
        encryptionId, // Seal 복호화를 위해 id 저장
    }));
    
    const uploadResultsPath = path.join(tmpDir, 'tiles_upload_results.json');
    const { blobIds: tileBlobIds, results: tileUploadResults } = await uploadFilesToWalrus(filesToUpload, uploadResultsPath);
    console.log(`✅ All ${totalTiles} tiles uploaded!`);
    
    // 업로드 결과 로깅
    // console.log(`\n📊 Upload Results:`);
    // console.log(JSON.stringify(tileUploadResults, null, 2));
    
    console.log(`\n🔍 Walrus 확인 방법:`);
    console.log(`   - Blob IDs: ${path.join(tmpDir, 'tiles_upload_results.json')}`);
    console.log(`   - 예시 URL: https://aggregator.walrus-testnet.walrus.space/v1/blobs/${tileBlobIds[0]}`);

    // 결과 정렬 및 저장 (Seal 암호화된 AES 키들)
    encryptedTiles.sort((a, b) => a.idx - b.idx);
    const sealEncryptedAesKeys: number[][] = encryptedTiles.map(r => Array.from(r.sealEncryptedAesKey));
    const encryptionIds: string[] = encryptedTiles.map(r => r.encryptionId);

    // Step 4: Manifest 파일 생성 및 업로드 (평문 JSON - 프론트엔드에서 읽어야 함)
    console.log(`📝 Step 4/4: Creating and uploading manifest to Walrus...`);
    const manifest = {
        version: 1,
        rows,
        cols,
        originalWidth: width,
        originalHeight: height,
        tiles: tileBlobIds // ["blob_id_0", "blob_id_1", ...]
    };
    
    // tmp/manifest.json 에 저장
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`📝 Manifest saved to: ${manifestPath}`);
    
    const manifestBuffer = Buffer.from(JSON.stringify(manifest));
    
    // Manifest는 평문으로 업로드 (프론트엔드에서 읽어야 함)
    console.log("📦 Uploading Plain Manifest to Walrus...");
    const manifestUploadResultsPath = path.join(tmpDir, 'manifest_upload_results.json');
    const { blobIds: manifestBlobIds, results: manifestUploadResults } = await uploadFilesToWalrus([{
        data: new Uint8Array(manifestBuffer),
        identifier: 'manifest.json',
    }], manifestUploadResultsPath);
    const manifestBlobId = manifestBlobIds[0];
    console.log(`✨ Manifest Blob ID: ${manifestBlobId}`);
    console.log(`🔍 Manifest Walrus URL: https://aggregator.walrus-testnet.walrus.space/v1/blobs/${manifestBlobId}`);

    // 4. SUI 트랜잭션 생성
    console.log("🔗 Submitting Transaction to SUI...");
    const tx = new Transaction();

    const answer = "sui";
    const answerBytes = ethers.toUtf8Bytes(answer);
    const hashHex = ethers.keccak256(answerBytes);
    const answerHash = Array.from(ethers.getBytes(hashHex));

    // Convert encryption IDs (strings) to vector<u8> arrays for Move
    const encryptionIdsBytes = encryptionIds.map(id => Array.from(new TextEncoder().encode(id)));

    tx.moveCall({
        target: `${PACKAGE_ID}::${MODULE_NAME}::create_game`,
        arguments: [
            tx.pure.vector("u8", answerHash),
            tx.pure.string(manifestBlobId), // Manifest Blob ID
            tx.pure.vector("vector<u8>", sealEncryptedAesKeys), // Seal로 암호화된 AES 키들
            tx.pure.vector("vector<u8>", encryptionIdsBytes) // Seal 복호화에 필요한 encryption IDs (as bytes, converted to String in Move)
        ]
    });

    try {
        const result = await suiClient.signAndExecuteTransaction({
            signer: keypair,
            transaction: tx,
            options: {
                showEffects: true,
                showObjectChanges: true
            }
        });

        console.log(`🎉 Game Created Successfully! Tx: ${result.digest}`);
        
        if (result.objectChanges) {
            const createdObject = result.objectChanges.find(
                (change) => change.type === 'created' && change.objectType.includes(`${MODULE_NAME}::Game`)
            );

            if (createdObject && 'objectId' in createdObject) {
                const gameId = createdObject.objectId;
                
                // 최종 요약 정보 저장
                const summaryPath = path.join(tmpDir, 'setup_summary.json');
                const summary = {
                    timestamp: new Date().toISOString(),
                    gameId,
                    transactionDigest: result.digest,
                    manifestBlobId,
                    totalTiles,
                    network: NETWORK,
                    packageId: PACKAGE_ID,
                    tmpDirectories: {
                        tiles: tilesDir,
                        encrypted: encryptedDir,
                        manifest: manifestPath,
                        manifestEncrypted: manifestEncryptedDir,
                        uploadResults: uploadResultsPath,
                        manifestUploadResults: manifestUploadResultsPath,
                    },
                    walrusUrls: {
                        manifest: `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${manifestBlobId}`,
                        exampleTile: `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${tileBlobIds[0]}`,
                    },
                };
                fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
                
                console.log(`\n${'='.repeat(60)}`);
                console.log(`✨ GAME CREATED SUCCESSFULLY!`);
                console.log(`${'='.repeat(60)}`);
                console.log(`🎮 GAME ID: ${gameId}`);
                console.log(`📦 Manifest Blob ID: ${manifestBlobId}`);
                console.log(`🔗 Transaction: https://suiscan.xyz/testnet/tx/${result.digest}`);
                console.log(`\n📁 모든 파일이 타임스탬프 디렉토리에 저장되었습니다: ${tmpDir}/`);
                console.log(`   - 타일 이미지: ${tilesDir}/`);
                console.log(`   - 암호화된 타일: ${encryptedDir}/`);
                console.log(`   - Manifest: ${manifestPath}`);
                console.log(`   - 업로드 결과: ${uploadResultsPath}`);
                console.log(`   - Manifest 업로드 결과: ${manifestUploadResultsPath}`);
                console.log(`   - 전체 요약: ${summaryPath}`);
                console.log(`\n🔍 Walrus 확인:`);
                console.log(`   - Manifest: https://aggregator.walrus-testnet.walrus.space/v1/blobs/${manifestBlobId}`);
                console.log(`   - 예시 타일: https://aggregator.walrus-testnet.walrus.space/v1/blobs/${tileBlobIds[0]}`);
                console.log(`\n👉 .env 파일과 Frontend의 networkConfig.ts를 이 GAME ID로 업데이트하세요.`);
                console.log(`${'='.repeat(60)}\n`);
            }
        }
    } catch (e) {
        console.error("❌ Failed to execute transaction:", e);
    }
}

createGame().catch(console.error);