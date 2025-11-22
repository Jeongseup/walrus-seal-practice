// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { walrus } from '@mysten/walrus';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const NETWORK = 'testnet';

const client = new SuiClient({
    url: getFullnodeUrl(NETWORK),
    network: NETWORK,
}).$extend(walrus({ network: NETWORK as 'testnet' | 'mainnet' }));

/**
 * Walrus에서 blob을 읽어오고 파일 사이즈를 체크하는 함수
 */
export async function retrieveBlob(blobId: string, savePath?: string): Promise<{
    buffer: Buffer;
    size: number;
    sizeKB: number;
    sizeMB: number;
    savedPath?: string;
}> {
    console.log(`📥 Reading blob from Walrus: ${blobId}`);
    
    const blobBytes = await client.walrus.readBlob({ blobId });
    const buffer = Buffer.from(blobBytes);
    
    const size = buffer.length;
    const sizeKB = size / 1024;
    const sizeMB = size / (1024 * 1024);
    
    console.log(`✅ Blob retrieved successfully!`);
    console.log(`   Size: ${size} bytes (${sizeKB.toFixed(2)} KB, ${sizeMB.toFixed(2)} MB)`);
    
    // 파일로 저장 (옵션)
    if (savePath) {
        fs.writeFileSync(savePath, buffer);
        console.log(`💾 Saved to: ${savePath}`);
    }
    
    return {
        buffer,
        size,
        sizeKB,
        sizeMB,
        savedPath: savePath,
    };
}

/**
 * 여러 blob을 한 번에 읽어오는 함수
 */
export async function retrieveMultipleBlobs(
    blobIds: string[],
    outputDir: string = 'tmp/downloaded_blobs'
): Promise<void> {
    console.log(`\n📥 Reading ${blobIds.length} blobs from Walrus...\n`);
    
    // 출력 디렉토리 생성
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const results = await Promise.all(
        blobIds.map(async (blobId, index) => {
            try {
                const savePath = path.join(outputDir, `blob_${index}_${blobId.slice(0, 8)}.bin`);
                const result = await retrieveBlob(blobId, savePath);
                
                return {
                    index,
                    blobId,
                    ...result,
                    success: true,
                };
            } catch (error: any) {
                console.error(`❌ Failed to retrieve blob ${blobId}:`, error.message);
                return {
                    index,
                    blobId,
                    success: false,
                    error: error.message,
                };
            }
        })
    );
    
    // 결과 요약
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 Summary:`);
    console.log(`   ✅ Successful: ${successful.length}/${blobIds.length}`);
    console.log(`   ❌ Failed: ${failed.length}/${blobIds.length}`);
    
    if (successful.length > 0) {
        const totalSize = successful.reduce((sum, r) => sum + (r.size || 0), 0);
        console.log(`   📦 Total Size: ${(totalSize / 1024).toFixed(2)} KB (${(totalSize / (1024 * 1024)).toFixed(2)} MB)`);
        console.log(`   📁 Saved to: ${outputDir}/`);
    }
    
    if (failed.length > 0) {
        console.log(`\n❌ Failed blob IDs:`);
        failed.forEach(f => console.log(`   - ${f.blobId}`));
    }
    
    // 결과를 JSON으로 저장
    const summaryPath = path.join(outputDir, 'read_results.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        total: blobIds.length,
        successful: successful.length,
        failed: failed.length,
        results: results.map(r => ({
            index: r.index,
            blobId: r.blobId,
            success: r.success,
            size: (r as any).size,
            sizeKB: (r as any).sizeKB,
            sizeMB: (r as any).sizeMB,
            savedPath: (r as any).savedPath,
            error: (r as any).error,
        })),
    }, null, 2));
    
    console.log(`\n📝 Results saved to: ${summaryPath}`);
    console.log(`${'='.repeat(60)}\n`);
}

/**
 * setup_game.ts에서 생성한 업로드 결과 파일을 읽어서 blob들을 다운로드
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('\n📖 Usage:\n');
        console.log('  방법 1: npm run 스크립트 사용 (추천)');
        console.log('    npm run read-blob <blobId>              # 단일 blob 읽기');
        console.log('    npm run read-blob:tiles                 # tmp/tiles_upload_results.json에서 타일 blobId 읽기');
        console.log('    npm run read-blob:manifest              # tmp/manifest.json에서 타일 blobId 읽기');
        console.log('    npm run read-blob -- --from-file <file> # 커스텀 JSON 파일에서 blobId 읽기\n');
        console.log('  방법 2: 직접 실행');
        console.log('    ts-node src/read_blob.ts <blobId>                    # 단일 blob 읽기');
        console.log('    ts-node src/read_blob.ts --from-file <json-file>     # JSON 파일에서 blobId 목록 읽기');
        console.log('    ts-node src/read_blob.ts --manifest                  # tmp/manifest.json에서 타일 blobId 읽기');
        console.log('    ts-node src/read_blob.ts --tiles                     # tmp/tiles_upload_results.json에서 타일 blobId 읽기\n');
        process.exit(1);
    }
    
    if (args[0] === '--from-file') {
        // JSON 파일에서 blobId 목록 읽기
        const jsonPath = args[1] || 'tmp/tiles_upload_results.json';
        if (!fs.existsSync(jsonPath)) {
            console.error(`❌ File not found: ${jsonPath}`);
            process.exit(1);
        }
        
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const blobIds = data.files?.map((f: any) => f.blobId) || [];
        
        if (blobIds.length === 0) {
            console.error(`❌ No blobIds found in ${jsonPath}`);
            process.exit(1);
        }
        
        await retrieveMultipleBlobs(blobIds);
    } else if (args[0] === '--manifest') {
        // manifest.json에서 타일 blobId 읽기
        const manifestPath = 'tmp/manifest.json';
        if (!fs.existsSync(manifestPath)) {
            console.error(`❌ File not found: ${manifestPath}`);
            process.exit(1);
        }
        
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const blobIds = manifest.tiles || [];
        
        if (blobIds.length === 0) {
            console.error(`❌ No tiles found in ${manifestPath}`);
            process.exit(1);
        }
        
        console.log(`📋 Found ${blobIds.length} tiles in manifest`);
        await retrieveMultipleBlobs(blobIds);
    } else if (args[0] === '--tiles') {
        // tiles_upload_results.json에서 타일 blobId 읽기
        const tilesPath = 'tmp/tiles_upload_results.json';
        if (!fs.existsSync(tilesPath)) {
            console.error(`❌ File not found: ${tilesPath}`);
            process.exit(1);
        }
        
        const data = JSON.parse(fs.readFileSync(tilesPath, 'utf-8'));
        const blobIds = data.files?.map((f: any) => f.blobId) || [];
        
        if (blobIds.length === 0) {
            console.error(`❌ No blobIds found in ${tilesPath}`);
            process.exit(1);
        }
        
        await retrieveMultipleBlobs(blobIds);
    } else {
        // 단일 blob 읽기
        const blobId = args[0];
        const outputDir = 'tmp/downloaded_blobs';
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const savePath = path.join(outputDir, `blob_${blobId.slice(0, 8)}.bin`);
        await retrieveBlob(blobId, savePath);
        
        console.log(`\n🔍 Walrus URL: https://aggregator.walrus-testnet.walrus.space/v1/blobs/${blobId}`);
    }
}

// 직접 실행될 때만 main 함수 실행
if (process.argv[1] && process.argv[1].endsWith('read_blob.ts')) {
    main().catch(console.error);
}

