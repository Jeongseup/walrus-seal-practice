// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { WalrusClient } from '@mysten/walrus';
import { Agent, setGlobalDispatcher } from 'undici';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// --- 환경 변수 체크 ---
if (!process.env.ORACLE_PRIVATE_KEY) {
    throw new Error("❌ ORACLE_PRIVATE_KEY environment variable missing");
}

const NETWORK = 'testnet';

// Node connect timeout is 10 seconds, and walrus nodes can be slow to respond
setGlobalDispatcher(
    new Agent({
        connectTimeout: 60_000,
        connect: { timeout: 60_000 },
    }),
);

const suiClient = new SuiClient({
    url: getFullnodeUrl(NETWORK),
});

const walrusClient = new WalrusClient({
    network: NETWORK,
    suiClient,
    storageNodeClientOptions: {
        timeout: 60_000,
    },
});

const { secretKey } = decodeSuiPrivateKey(process.env.ORACLE_PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

/**
 * 단일 blob 삭제 함수
 */
async function deleteBlob(blobObjectId: string): Promise<void> {
    console.log(`🗑️  Deleting blob: ${blobObjectId}`);
    
    try {
        await walrusClient.executeDeleteBlobTransaction({
            signer: keypair,
            blobObjectId: blobObjectId,
        });
        
        console.log(`✅ Successfully deleted blob: ${blobObjectId}`);
    } catch (error: any) {
        console.error(`❌ Failed to delete blob ${blobObjectId}:`, error.message);
        throw error;
    }
}

/**
 * 여러 blob을 한 번에 삭제하는 함수
 */
async function deleteMultipleBlobs(blobObjectIds: string[]): Promise<void> {
    console.log(`\n🗑️  Deleting ${blobObjectIds.length} blobs...\n`);
    
    const results = await Promise.allSettled(
        blobObjectIds.map(async (blobObjectId) => {
            try {
                await deleteBlob(blobObjectId);
                return { blobObjectId, success: true };
            } catch (error: any) {
                return { blobObjectId, success: false, error: error.message };
            }
        })
    );
    
    // 결과 요약
    const successful = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value.success)
        .map(r => r.value.blobObjectId);
    const failed = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && !r.value.success)
        .map(r => ({ blobObjectId: r.value.blobObjectId, error: r.value.error }));
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 Summary:`);
    console.log(`   ✅ Successfully deleted: ${successful.length}/${blobObjectIds.length}`);
    console.log(`   ❌ Failed: ${failed.length}/${blobObjectIds.length}`);
    
    if (failed.length > 0) {
        console.log(`\n❌ Failed blob IDs:`);
        failed.forEach(f => console.log(`   - ${f.blobObjectId}: ${f.error}`));
    }
    
    // 결과를 JSON으로 저장
    const outputDir = 'tmp';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const summaryPath = path.join(outputDir, 'delete_results.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        total: blobObjectIds.length,
        successful: successful.length,
        failed: failed.length,
        successfulBlobIds: successful,
        failedBlobIds: failed,
    }, null, 2));
    
    console.log(`\n📝 Results saved to: ${summaryPath}`);
    console.log(`${'='.repeat(60)}\n`);
}

/**
 * 단일 파일에서 blobObjectId를 추출하는 헬퍼 함수
 */
function extractBlobIdsFromFile(jsonPath: string): string[] {
    if (!fs.existsSync(jsonPath)) {
        console.error(`❌ File not found: ${jsonPath}`);
        return [];
    }
    
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const blobObjectIds: string[] = [];
    
    if (data.files) {
        // tiles_upload_results.json 또는 manifest_upload_results.json 형식
        data.files.forEach((file: any) => {
            if (file.result?.blobObject?.id?.id) {
                blobObjectIds.push(file.result.blobObject.id.id);
            } else if (file.blobObjectId) {
                blobObjectIds.push(file.blobObjectId);
            }
        });
    } else if (Array.isArray(data)) {
        // 배열 형식
        data.forEach((item: any) => {
            if (item.blobObject?.id?.id) {
                blobObjectIds.push(item.blobObject.id.id);
            } else if (item.blobObjectId) {
                blobObjectIds.push(item.blobObjectId);
            }
        });
    }
    
    return blobObjectIds;
}

/**
 * 업로드 결과 파일에서 blobObjectId를 추출하여 삭제
 */
async function deleteBlobsFromUploadResults(jsonPath: string): Promise<void> {
    const blobObjectIds = extractBlobIdsFromFile(jsonPath);
    
    if (blobObjectIds.length === 0) {
        console.error(`❌ No blobObjectIds found in ${jsonPath}`);
        console.log('Expected format: { files: [{ result: { blobObject: { id: { id: "..." } } } }] }');
        process.exit(1);
    }
    
    console.log(`📋 Found ${blobObjectIds.length} blobObjectIds in ${jsonPath}`);
    await deleteMultipleBlobs(blobObjectIds);
}

/**
 * 디렉토리에서 모든 업로드 결과 파일을 찾아서 blob 삭제
 */
async function deleteBlobsFromDirectory(dirPath: string): Promise<void> {
    if (!fs.existsSync(dirPath)) {
        console.error(`❌ Directory not found: ${dirPath}`);
        process.exit(1);
    }
    
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
        // 디렉토리가 아니면 파일로 처리
        await deleteBlobsFromUploadResults(dirPath);
        return;
    }
    
    // 디렉토리에서 업로드 결과 파일 찾기
    const manifestFile = path.join(dirPath, 'manifest_upload_results.json');
    const tilesFile = path.join(dirPath, 'tiles_upload_results.json');
    
    const allBlobIds: string[] = [];
    const processedFiles: string[] = [];
    
    // manifest 파일 처리
    if (fs.existsSync(manifestFile)) {
        const ids = extractBlobIdsFromFile(manifestFile);
        allBlobIds.push(...ids);
        processedFiles.push(manifestFile);
        console.log(`📋 Found ${ids.length} blob(s) in manifest_upload_results.json`);
    }
    
    // tiles 파일 처리
    if (fs.existsSync(tilesFile)) {
        const ids = extractBlobIdsFromFile(tilesFile);
        allBlobIds.push(...ids);
        processedFiles.push(tilesFile);
        console.log(`📋 Found ${ids.length} blob(s) in tiles_upload_results.json`);
    }
    
    if (allBlobIds.length === 0) {
        console.error(`❌ No blobObjectIds found in directory: ${dirPath}`);
        console.log('Looking for: manifest_upload_results.json and/or tiles_upload_results.json');
        process.exit(1);
    }
    
    // 중복 제거 (같은 blob이 여러 파일에 있을 수 있음)
    const uniqueBlobIds = [...new Set(allBlobIds)];
    
    console.log(`\n📊 Total unique blobs to delete: ${uniqueBlobIds.length}`);
    console.log(`   From ${processedFiles.length} file(s): ${processedFiles.map(f => path.basename(f)).join(', ')}\n`);
    
    await deleteMultipleBlobs(uniqueBlobIds);
}

/**
 * main 함수
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('\n📖 Usage:\n');
        console.log('  방법 1: npm run 스크립트 사용 (추천)');
        console.log('    npm run delete-blob <blobObjectId>                    # 단일 blob 삭제');
        console.log('    npm run delete-blob:tiles                              # tmp/tiles_upload_results.json에서 blob 삭제');
        console.log('    npm run delete-blob:manifest                           # tmp/manifest_upload_results.json에서 blob 삭제');
        console.log('    npm run delete-blob -- --from-file <file-or-dir>       # JSON 파일 또는 디렉토리에서 blob 삭제');
        console.log('                                                             (디렉토리면 manifest + tiles 모두 삭제)\n');
        console.log('  방법 2: 직접 실행');
        console.log('    ts-node src/delete_blob.ts <blobObjectId>              # 단일 blob 삭제');
        console.log('    ts-node src/delete_blob.ts <directory>                 # 디렉토리에서 모든 blob 삭제');
        console.log('    ts-node src/delete_blob.ts --from-file <file-or-dir>   # JSON 파일 또는 디렉토리에서 blob 삭제');
        console.log('    ts-node src/delete_blob.ts --tiles                     # tmp/tiles_upload_results.json에서 blob 삭제');
        console.log('    ts-node src/delete_blob.ts --manifest                  # tmp/manifest_upload_results.json에서 blob 삭제\n');
        console.log('  예시:');
        console.log('    npm run delete-blob -- --from-file ./tmp/testnet-2025-11-21_13-37-21-208');
        console.log('      → 해당 디렉토리의 manifest + tiles 모든 blob 삭제\n');
        console.log('  ⚠️  주의: blob 삭제는 되돌릴 수 없습니다!');
        process.exit(1);
    }
    
    if (args[0] === '--from-file') {
        const jsonPath = args[1] || 'tmp/tiles_upload_results.json';
        // 디렉토리인지 파일인지 확인
        if (fs.existsSync(jsonPath)) {
            const stat = fs.statSync(jsonPath);
            if (stat.isDirectory()) {
                await deleteBlobsFromDirectory(jsonPath);
            } else {
                await deleteBlobsFromUploadResults(jsonPath);
            }
        } else {
            console.error(`❌ Path not found: ${jsonPath}`);
            process.exit(1);
        }
    } else if (args[0] === '--tiles') {
        await deleteBlobsFromUploadResults('tmp/tiles_upload_results.json');
    } else if (args[0] === '--manifest') {
        await deleteBlobsFromUploadResults('tmp/manifest_upload_results.json');
    } else {
        // 단일 blob 삭제 또는 디렉토리 경로
        const inputPath = args[0];
        if (fs.existsSync(inputPath)) {
            const stat = fs.statSync(inputPath);
            if (stat.isDirectory()) {
                await deleteBlobsFromDirectory(inputPath);
            } else {
                // 파일이면 blob ID로 간주
                await deleteBlob(inputPath);
            }
        } else {
            // 파일이 존재하지 않으면 blob ID로 간주
            await deleteBlob(inputPath);
        }
    }
}

// 직접 실행될 때만 main 함수 실행
if (process.argv[1] && process.argv[1].endsWith('delete_blob.ts')) {
    main().catch(console.error);
}

