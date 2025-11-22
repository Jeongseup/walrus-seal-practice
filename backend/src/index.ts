import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SealClient } from '@mysten/seal';
import dotenv from 'dotenv';

dotenv.config();

const NETWORK = 'testnet';
const PACKAGE_ID = process.env.PACKAGE_ID!;
const MODULE_NAME = 'mosaic';
const ORACLE_CAP_ID = process.env.ORACLE_CAP_ID!;

// Seal 서버 설정
const SEAL_SERVER_IDS = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8"
];

const { secretKey } = decodeSuiPrivateKey(process.env.ORACLE_PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

// SealClient 초기화
const sealClient = new SealClient({
    suiClient: client,
    serverConfigs: SEAL_SERVER_IDS.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});

console.log(`🤖 Oracle Bot Started (New SDK)! Address: ${keypair.toSuiAddress()}`);

async function startListener() {
    let cursor: any = null;

    const eventFilter = {
        MoveEventType: `${PACKAGE_ID}::${MODULE_NAME}::TileRevealRequested`
    };

    while (true) {
        try {
            const events = await client.queryEvents({
                query: eventFilter,
                cursor: cursor,
                limit: 50,
                order: 'ascending'
            });

            for (const event of events.data) {
                await handleRevealRequest(event);
            }

            if (events.data.length > 0) {
                cursor = events.nextCursor;
            } else {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (e) {
            console.error("Event polling error:", e);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function handleRevealRequest(event: any) {
    const { game_id, tile_index } = event.parsedJson;
    console.log(`📩 Request detected! Game: ${game_id}, Tile: ${tile_index}`);

    try {
        // 1. 중복 처리 방지 (State Check)
        const gameObject = await client.getObject({
            id: game_id,
            options: { showContent: true }
        });

        if (gameObject.data?.content?.dataType === 'moveObject') {
            const fields = gameObject.data.content.fields as any;
            const decryptedKeys = fields.decrypted_tile_keys;

            const tileData = decryptedKeys[Number(tile_index)];
            const isAlreadyRevealed = tileData && tileData.fields && tileData.fields.vec && tileData.fields.vec.length > 0;

            if (isAlreadyRevealed) {
                console.log(`⚠️ Tile ${tile_index} is already revealed. Skipping.`);
                return;
            }

            // 2. Seal로 AES 키 복호화
            const encryptionIds = fields.encryption_ids as string[];
            const encryptedTileKeys = fields.encrypted_tile_keys as number[][];

            if (!encryptionIds || !encryptedTileKeys) {
                console.error(`❌ Missing encryption_ids or encrypted_tile_keys in game object`);
                return;
            }

            const encryptionId = encryptionIds[Number(tile_index)];
            const encryptedAesKey = new Uint8Array(encryptedTileKeys[Number(tile_index)]);

            console.log(`🔓 Decrypting AES key for tile ${tile_index} using Seal...`);
            
            try {
                // Seal recover를 사용하여 AES 키 복호화
                const recoveredAesKey = await sealClient.recover({
                    threshold: 2,
                    packageId: PACKAGE_ID,
                    id: encryptionId,
                    ciphertext: encryptedAesKey,
                });

                // 복호화된 AES 키를 hex 문자열로 변환하여 체인에 저장
                const aesKeyHex = Buffer.from(recoveredAesKey).toString('hex');
                const decryptedKey = Array.from(new TextEncoder().encode(aesKeyHex));

                console.log(`✅ AES key recovered for tile ${tile_index}`);

                // 3. 트랜잭션 생성 (New SDK)
                const tx = new Transaction();
                
                tx.moveCall({
                    target: `${PACKAGE_ID}::${MODULE_NAME}::fulfill_reveal`,
                    arguments: [
                        tx.object(ORACLE_CAP_ID),
                        tx.object(game_id),
                        tx.pure.u64(Number(tile_index)), // [Tip] u64 타입 명시
                        tx.pure.vector("u8", decryptedKey) // AES 키 (hex string bytes)
                    ]
                });

                // 4. 서명 및 전송 (New SDK)
                const result = await client.signAndExecuteTransaction({
                    signer: keypair,
                    transaction: tx,
                    options: { showEffects: true }
                });

                if (result.effects?.status.status === 'success') {
                    console.log(`✅ Reveal Success! TxDigest: ${result.digest}`);
                } else {
                    console.error(`❌ Reveal Failed: ${result.effects?.status.error}`);
                }
            } catch (decryptError) {
                console.error(`❌ Failed to decrypt AES key for tile ${tile_index}:`, decryptError);
                return;
            }
        } else {
            console.error(`❌ Invalid game object structure`);
        }

    } catch (e) {
        console.error("Error processing request:", e);
    }
}

startListener();