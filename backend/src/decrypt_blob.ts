// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromHex, toHex } from '@mysten/sui/utils';
import { SealClient } from '@mysten/seal';
import { walrus } from '@mysten/walrus';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

dotenv.config();

// --- 환경 변수 체크 ---
if (!process.env.ORACLE_PRIVATE_KEY || !process.env.PACKAGE_ID) {
    throw new Error("❌ Environment variables missing");
}

const NETWORK = 'testnet';
const PACKAGE_ID = process.env.PACKAGE_ID!;

// Seal 서버 설정
const serverObjectIds = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
];

const { secretKey } = decodeSuiPrivateKey(process.env.ORACLE_PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const baseSuiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });
const suiClient = baseSuiClient.$extend(walrus({ network: NETWORK as 'testnet' | 'mainnet' }));

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
 * Walrus에서 blob을 다운로드하고 Seal로 복호화하는 함수
 */
async function decryptBlob(
    blobId: string,
    id: string, // 암호화 시 사용한 id (policyObjectBytes + nonce)
    outputPath?: string
): Promise<{
    decryptedData: Uint8Array;
    size: number;
    savedPath?: string;
}> {
    console.log(`📥 Downloading blob from Walrus: ${blobId}`);
    
    // 1. Walrus에서 암호화된 blob 다운로드
    const encryptedBlobBytes = await suiClient.walrus.readBlob({ blobId });
    const encryptedData = new Uint8Array(encryptedBlobBytes);
    
    console.log(`✅ Blob downloaded: ${encryptedData.length} bytes`);
    console.log(`🔓 Decrypting with Seal (id: ${id})...`);
    
    // 2. Seal로 복호화
    const decryptedData = await sealClient.decrypt({
        encryptedObject: encryptedData,
        id,
        packageId: PACKAGE_ID,
    });
    
    console.log(`✅ Decrypted successfully: ${decryptedData.length} bytes`);
    
    // 3. 파일로 저장 (옵션)
    if (outputPath) {
        fs.writeFileSync(outputPath, Buffer.from(decryptedData));
        console.log(`💾 Saved to: ${outputPath}`);
    }
    
    return {
        decryptedData,
        size: decryptedData.length,
        savedPath: outputPath,
    };
}

/**
 * 여러 blob을 복호화하는 함수
 */
async function decryptMultipleBlobs(
    blobIds: string[],
    ids: string[], // 각 blob에 대응하는 id 배열
    outputDir: string = 'tmp/decrypted'
): Promise<void> {
    console.log(`\n🔓 Decrypting ${blobIds.length} blobs...\n`);
    
    if (blobIds.length !== ids.length) {
        throw new Error(`❌ blobIds length (${blobIds.length}) must match ids length (${ids.length})`);
    }
    
    // 출력 디렉토리 생성
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const results = await Promise.allSettled(
        blobIds.map(async (blobId, index) => {
            try {
                const id = ids[index];
                const outputPath = path.join(outputDir, `decrypted_${index}.png`);
                const result = await decryptBlob(blobId, id, outputPath);
                
                return {
                    index,
                    blobId,
                    id,
                    ...result,
                    success: true,
                };
            } catch (error: any) {
                console.error(`❌ Failed to decrypt blob ${blobId}:`, error.message);
                return {
                    index,
                    blobId,
                    id: ids[index],
                    success: false,
                    error: error.message,
                };
            }
        })
    );
    
    // 결과 요약
    const successful = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value.success)
        .map(r => r.value);
    const failed = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && !r.value.success)
        .map(r => r.value);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 Summary:`);
    console.log(`   ✅ Successfully decrypted: ${successful.length}/${blobIds.length}`);
    console.log(`   ❌ Failed: ${failed.length}/${blobIds.length}`);
    
    if (successful.length > 0) {
        const totalSize = successful.reduce((sum, r) => sum + (r.size || 0), 0);
        console.log(`   📦 Total Size: ${(totalSize / 1024).toFixed(2)} KB (${(totalSize / (1024 * 1024)).toFixed(2)} MB)`);
        console.log(`   📁 Saved to: ${outputDir}/`);
    }
    
    if (failed.length > 0) {
        console.log(`\n❌ Failed blob IDs:`);
        failed.forEach(f => console.log(`   - ${f.blobId}: ${f.error}`));
    }
    
    // 결과를 JSON으로 저장
    const summaryPath = path.join(outputDir, 'decrypt_results.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        total: blobIds.length,
        successful: successful.length,
        failed: failed.length,
        results: results.map((r, idx) => {
            if (r.status === 'fulfilled') {
                return {
                    index: idx,
                    blobId: blobIds[idx],
                    id: ids[idx],
                    success: r.value.success,
                    size: r.value.size,
                    savedPath: r.value.savedPath,
                    error: r.value.error,
                };
            } else {
                return {
                    index: idx,
                    blobId: blobIds[idx],
                    id: ids[idx],
                    success: false,
                    error: r.reason?.message || 'Unknown error',
                };
            }
        }),
    }, null, 2));
    
    console.log(`\n📝 Results saved to: ${summaryPath}`);
    console.log(`${'='.repeat(60)}\n`);
}

/**
 * setup_game.ts에서 생성한 업로드 결과에서 id를 추출하여 복호화
 */
async function decryptFromUploadResults(jsonPath: string): Promise<void> {
    if (!fs.existsSync(jsonPath)) {
        console.error(`❌ File not found: ${jsonPath}`);
        process.exit(1);
    }
    
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    
    // blobId와 id 추출
    const blobIds: string[] = [];
    const ids: string[] = [];
    
    if (data.files) {
        // tiles_upload_results.json 형식
        data.files.forEach((file: any, index: number) => {
            if (file.blobId) {
                blobIds.push(file.blobId);
                // encryptionId가 저장되어 있으면 사용
                if (file.encryptionId) {
                    ids.push(file.encryptionId);
                } else {
                    console.warn(`⚠️  Warning: encryptionId not found for blob ${file.blobId}`);
                    ids.push(''); // 빈 문자열로 채움
                }
            }
        });
    }
    
    if (blobIds.length === 0) {
        console.error(`❌ No blobIds found in ${jsonPath}`);
        process.exit(1);
    }
    
    // id가 없으면 사용자에게 요청
    const validIds = ids.filter(id => id !== '');
    if (validIds.length === 0) {
        console.error(`❌ No encryption IDs found in ${jsonPath}`);
        console.log(`\n💡 Tip: Make sure to run 'npm run setup' with the latest version that saves encryption IDs.`);
        process.exit(1);
    }
    
    if (validIds.length !== blobIds.length) {
        console.warn(`⚠️  Warning: Some encryption IDs are missing. Only ${validIds.length}/${blobIds.length} will be decrypted.`);
    }
    
    // 유효한 id만 사용
    const validBlobIds = blobIds.filter((_, idx) => ids[idx] !== '');
    const validIdsFiltered = ids.filter(id => id !== '');
    
    await decryptMultipleBlobs(validBlobIds, validIdsFiltered);
}

/**
 * 암호화된 파일에서 id를 재구성하여 복호화
 */
async function decryptFromEncryptedFiles(encryptedDir: string = 'tmp/encrypted'): Promise<void> {
    if (!fs.existsSync(encryptedDir)) {
        console.error(`❌ Directory not found: ${encryptedDir}`);
        console.log(`💡 Run 'npm run setup' first to generate encrypted files.`);
        process.exit(1);
    }
    
    // tiles_upload_results.json에서 blobId 읽기
    const uploadResultsPath = 'tmp/tiles_upload_results.json';
    if (!fs.existsSync(uploadResultsPath)) {
        console.error(`❌ File not found: ${uploadResultsPath}`);
        process.exit(1);
    }
    
    const uploadData = JSON.parse(fs.readFileSync(uploadResultsPath, 'utf-8'));
    const blobIds: string[] = uploadData.files?.map((f: any) => f.blobId) || [];
    
    if (blobIds.length === 0) {
        console.error(`❌ No blobIds found in ${uploadResultsPath}`);
        process.exit(1);
    }
    
    // encrypted 파일에서 id 재구성
    // setup_game.ts에서 id는 packageIdHex + nonce로 생성되었지만,
    // nonce는 저장되지 않았으므로 다른 방법이 필요합니다.
    // 실제로는 Seal의 복호화가 id를 필요로 하므로, 
    // 암호화 시 사용한 id를 저장하거나 재구성해야 합니다.
    
    console.log(`\n⚠️  Note: Decryption requires the original encryption IDs.`);
    console.log(`   Since nonces were not saved, we'll try to reconstruct IDs from packageId.\n`);
    
    const packageIdHex = PACKAGE_ID.startsWith('0x') ? PACKAGE_ID.slice(2) : PACKAGE_ID;
    const policyObjectBytes = fromHex(packageIdHex);
    
    // 각 타일에 대해 id를 재구성 (nonce는 알 수 없으므로 실패할 수 있음)
    // 대신 사용자가 직접 id를 제공하거나, 다른 방법을 사용해야 합니다.
    console.error(`❌ Cannot reconstruct IDs without nonces.`);
    console.log(`💡 Please use the --with-ids option or provide IDs manually.`);
    process.exit(1);
}

/**
 * main 함수
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('\n📖 Usage:\n');
        console.log('  방법 1: 단일 blob 복호화 (id 필요)');
        console.log('    npm run decrypt-blob <blobId> <id>              # 단일 blob 복호화');
        console.log('    npm run decrypt-blob <blobId> <id> --save <path> # 특정 경로에 저장\n');
        console.log('  방법 2: 여러 blob 복호화');
        console.log('    npm run decrypt-blob --from-file <json-file>    # JSON 파일에서 blobId와 id 읽기\n');
        console.log('  ⚠️  Note: Decryption requires the original encryption ID.');
        console.log('     The ID is constructed from packageId + nonce used during encryption.\n');
        process.exit(1);
    }
    
    if (args[0] === '--from-file') {
        const jsonPath = args[1] || 'tmp/tiles_upload_results.json';
        await decryptFromUploadResults(jsonPath);
    } else if (args[0] === '--from-encrypted') {
        await decryptFromEncryptedFiles();
    } else {
        // 단일 blob 복호화
        const blobId = args[0];
        const id = args[1];
        
        if (!id) {
            console.error('❌ ID is required for decryption');
            console.log('Usage: npm run decrypt-blob <blobId> <id>');
            process.exit(1);
        }
        
        const saveIndex = args.indexOf('--save');
        const outputPath = saveIndex !== -1 && args[saveIndex + 1] 
            ? args[saveIndex + 1]
            : `tmp/decrypted/blob_${blobId.slice(0, 8)}.png`;
        
        // 출력 디렉토리 생성
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        await decryptBlob(blobId, id, outputPath);
        console.log(`\n🔍 Walrus URL: https://aggregator.walrus-testnet.walrus.space/v1/blobs/${blobId}`);
    }
}

// 직접 실행될 때만 main 함수 실행
if (process.argv[1] && process.argv[1].endsWith('decrypt_blob.ts')) {
    main().catch(console.error);
}

