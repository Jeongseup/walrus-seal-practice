import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction, useSuiClientQuery, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useNetworkVariable } from "./networkConfig";
import { useState, useMemo } from "react";
import { ethers } from "ethers";
import { useQuery } from "@tanstack/react-query";

// AES-GCM 복호화 함수 (브라우저용)
async function decryptTile(encryptedBlob: Uint8Array, keyHex: string): Promise<string> {
    // 키를 hex 문자열에서 바이트 배열로 변환
    const keyBytes = new Uint8Array(
        keyHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
    );

    // 포맷: [IV(12)] + [Tag(16)] + [EncryptedData]
    const iv = encryptedBlob.slice(0, 12);
    const tag = encryptedBlob.slice(12, 28);
    const ciphertext = encryptedBlob.slice(28);

    // Web Crypto API는 tag를 ciphertext 끝에 붙여야 함
    const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
    ciphertextWithTag.set(ciphertext);
    ciphertextWithTag.set(tag, ciphertext.length);

    const algorithm = {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128, // 16 bytes = 128 bits
    };

    const key = await window.crypto.subtle.importKey(
        "raw",
        keyBytes,
        "AES-GCM",
        false,
        ["decrypt"]
    );

    try {
        const decrypted = await window.crypto.subtle.decrypt(
            algorithm,
            key,
            ciphertextWithTag
        );
        const blob = new Blob([decrypted], { type: "image/png" });
        return URL.createObjectURL(blob);
    } catch (e) {
        console.error("Decryption error", e);
        return "";
    }
}

// 타일 컴포넌트
function Tile({
    index,
    isRevealed,
    aesKeyHex,
    blobId,
    onClick,
}: {
    index: number;
    isRevealed: boolean;
    aesKeyHex: string | null;
    blobId: string | undefined;
    onClick: () => void;
}) {
    const { data: tileImageUrl } = useQuery({
        queryKey: ['tile', index, aesKeyHex, blobId],
        queryFn: async () => {
            if (!isRevealed || !aesKeyHex || !blobId) return null;

            // Walrus에서 암호화된 타일 다운로드
            const response = await fetch(`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${blobId}`);
            const blobData = new Uint8Array(await response.arrayBuffer());

            // 브라우저에서 복호화
            return await decryptTile(blobData, aesKeyHex);
        },
        enabled: isRevealed && !!aesKeyHex && !!blobId,
    });

    return (
        <div 
            onClick={onClick}
            style={{
                width: 40, height: 40,
                backgroundColor: isRevealed ? 'white' : '#333',
                border: '1px solid #ccc',
                cursor: isRevealed ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: isRevealed ? 'black' : 'white',
                overflow: 'hidden',
            }}
        >
            {isRevealed && tileImageUrl ? (
                <img 
                    src={tileImageUrl} 
                    alt={`Tile ${index}`}
                    style={{ 
                        width: '100%', 
                        height: '100%', 
                        objectFit: 'cover' 
                    }}
                />
            ) : isRevealed ? (
                "O"
            ) : (
                "?"
            )}
        </div>
    );
}

function App() {
    const account = useCurrentAccount();
    const { mutate: signAndExecute } = useSignAndExecuteTransaction();
    const client = useSuiClient();
    
    const packageId = useNetworkVariable("packageId");
    const gameId = useNetworkVariable("gameId");
    const moduleName = useNetworkVariable("moduleName");

    const [guessInput, setGuessInput] = useState("");
    const [saltInput, setSaltInput] = useState("my_secret_salt"); // 실제론 랜덤 생성 권장

    // 1. 게임 상태 조회 (On-chain Data Fetching)
    // 👇 [수정] 폴링(Polling) 추가: 2초마다 자동으로 데이터를 다시 가져옴
    // 데이터는 SuiClientProvider의 client를 통해 Sui 네트워크 RPC에서 가져옵니다
    const { data: gameObject, refetch, isLoading, isFetching } = useSuiClientQuery("getObject", {
        id: gameId,
        options: { showContent: true }
    }, {
        refetchInterval: 10000, // 2000ms = 2초 (자동 새로고침)
        refetchIntervalInBackground: true, // 백그라운드에서도 폴링 계속
    });

    // 디버깅: 데이터 fetch 상태 확인
    console.log("Game Object Fetch Status:", { 
        isLoading, 
        isFetching, 
        hasData: !!gameObject,
        timestamp: new Date().toISOString()
    });

    // 데이터 파싱
    // Game struct: decrypted_tile_keys는 vector<Option<vector<u8>>> 타입
    const fields = gameObject?.data?.content?.dataType === "moveObject" 
        ? (gameObject.data.content.fields as Record<string, unknown>) 
        : null;

    // 디버깅: fields 구조 확인
    if (fields) {
        console.log("Game Fields:", Object.keys(fields));
        console.log("decrypted_tile_keys structure:", fields.decrypted_tile_keys);
    }

    // decrypted_tile_keys 파싱
    // 실제 구조: [null, null, Array(15), null, ...] 형태로 이미 파싱됨
    // null = None (비공개), Array = Some(vector<u8>) (공개됨)
    let decryptedKeys: (unknown[] | null)[] = [];
    if (fields?.decrypted_tile_keys) {
        const decryptedKeysData = fields.decrypted_tile_keys;
        
        if (Array.isArray(decryptedKeysData)) {
            // 이미 배열로 파싱된 경우 (null 또는 배열)
            decryptedKeys = decryptedKeysData as (unknown[] | null)[];
        } else if (typeof decryptedKeysData === 'object' && decryptedKeysData !== null) {
            // 아직 파싱되지 않은 경우: { type: "...", fields: { vec: [...] } }
            const parsed = decryptedKeysData as {
                type?: string;
                fields?: { vec?: unknown[] };
            };
            if (parsed.fields?.vec && Array.isArray(parsed.fields.vec)) {
                decryptedKeys = parsed.fields.vec as (unknown[] | null)[];
            }
        }
    }

    const isSolved = fields?.is_solved === true;
    const manifestBlobId = fields?.walrus_blob_id as string | undefined;

    // 👇 [수정] 타일이 공개되었는지 확인하는 헬퍼 함수
    // null이면 None (비공개), 배열이면 Some (공개됨)
    const checkIsRevealed = (tileData: unknown[] | null | undefined): boolean => {
        // null이거나 undefined면 비공개
        if (tileData === null || tileData === undefined) return false;
        
        // 배열이면 공개됨 (길이가 0보다 큰지 확인)
        return Array.isArray(tileData) && tileData.length > 0;
    };

    // AES 키 추출 헬퍼 함수
    const extractAesKeyHex = (tileData: unknown[] | null | undefined): string | null => {
        if (!checkIsRevealed(tileData)) return null;
        if (!Array.isArray(tileData)) return null;
        
        // tileData는 hex 문자열의 바이트 배열
        const keyBytes = new Uint8Array(tileData as number[]);
        return new TextDecoder().decode(keyBytes);
    };

    // Manifest 가져오기
    const { data: manifest } = useQuery({
        queryKey: ['manifest', manifestBlobId],
        queryFn: async () => {
            if (!manifestBlobId) return null;
            const response = await fetch(`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${manifestBlobId}`);
            const blobData = await response.arrayBuffer();
            const manifestText = new TextDecoder().decode(blobData);
            return JSON.parse(manifestText) as {
                version: number;
                rows: number;
                cols: number;
                originalWidth: number;
                originalHeight: number;
                tiles: string[];
            };
        },
        enabled: !!manifestBlobId,
    });


    // 2. 타일 클릭 핸들러 (Request Reveal)
    const handleTileClick = (index: number) => {
        if (!account) {
            alert("지갑을 연결해주세요!");
            return;
        }
        
        const txb = new Transaction();
        
        // splitCoins는 number, string, bigint를 직접 받을 수 있습니다
        const [coin] = txb.splitCoins(txb.gas, [1_000]); // 1 SUI

        txb.moveCall({
            target: `${packageId}::${moduleName}::request_reveal`,
            arguments: [
                txb.object(gameId),
                txb.pure.u64(index), // u64 타입으로 명시
                coin
            ]
        });

        signAndExecute({
            transaction: txb,
        }, {
            onSuccess: async (result) => {
                console.log("Transaction Result:", result);
                console.log("Transaction Digest:", result.digest);
                
                // result 객체에 이미 effects가 포함되어 있는지 확인
                const resultAny = result as { digest?: string; effects?: { status?: { status?: string; error?: unknown } | string } };
                if (resultAny.effects) {
                    console.log("Effects already in result:", JSON.stringify(resultAny.effects, null, 2));
                    const effectsStatus = resultAny.effects.status;
                    console.log("Effects status:", effectsStatus, "Type:", typeof effectsStatus);
                    
                    // status 구조 확인
                    let status: string | undefined;
                    let error: unknown | undefined;
                    
                    if (typeof effectsStatus === 'string') {
                        status = effectsStatus;
                    } else if (typeof effectsStatus === 'object' && effectsStatus !== null) {
                        if ('status' in effectsStatus) {
                            status = (effectsStatus as { status?: string }).status;
                        }
                        if ('error' in effectsStatus) {
                            error = (effectsStatus as { error?: unknown }).error;
                        }
                    }
                    
                    console.log("Parsed status:", status, "Error:", error);
                    
                    // 성공 조건: status가 "success"이거나, error가 없고 status가 "failure"가 아닌 경우
                    if (status === "success" || (!error && status !== "failure")) {
                        console.log("✅ 트랜잭션 성공! 데이터를 새로고침합니다.");
                        // 트랜잭션 성공 시 즉시 refetch (폴링도 계속 작동)
                        refetch();
                        alert(`✅ 타일 공개 요청 성공!\n트랜잭션: ${result.digest}\n잠시 후 백엔드 봇이 처리합니다.`);
                        return;
                    } else {
                        // 실제로 실패한 경우에만 에러 표시
                        if (error || status === "failure") {
                            console.error("Transaction failed:", error || status);
                            alert(`❌ 트랜잭션 실패!\n에러: ${error || status || "알 수 없는 오류"}\n트랜잭션: ${result.digest}`);
                        } else {
                            // status가 명확하지 않은 경우, 트랜잭션 상세 정보를 확인하도록 진행
                            console.log("Status unclear, checking transaction details...");
                        }
                    }
                }
                
                // 트랜잭션 상세 정보 확인 (재시도 로직 포함)
                if (result.digest && client) {
                    const maxRetries = 5;
                    const retryDelay = 1000; // 1초
                    
                    for (let i = 0; i < maxRetries; i++) {
                        try {
                            // 마지막 시도가 아니면 잠시 대기
                            if (i > 0) {
                                await new Promise(resolve => setTimeout(resolve, retryDelay * i));
                            }
                            
                            const txDetails = await client.getTransactionBlock({
                                digest: result.digest,
                                options: {
                                    showEffects: true,
                                    showEvents: true,
                                }
                            });
                            
                            console.log("Transaction Details:", txDetails);
                            
                            const status = txDetails.effects?.status?.status;
                            if (status === "success") {
                                console.log("✅ 트랜잭션 성공! 데이터를 새로고침합니다.");
                                // 트랜잭션 성공 시 즉시 refetch (폴링도 계속 작동)
                                refetch();
                                alert(`✅ 타일 공개 요청 성공!\n트랜잭션: ${result.digest}\n잠시 후 백엔드 봇이 처리합니다.`);
                                return;
                            } else {
                                const error = txDetails.effects?.status?.error;
                                console.error("Transaction failed:", error);
                                alert(`❌ 트랜잭션 실패!\n에러: ${error || "알 수 없는 오류"}\n트랜잭션: ${result.digest}`);
                                return;
                            }
                        } catch (err: unknown) {
                            const error = err as Error;
                            console.log(`Attempt ${i + 1}/${maxRetries} failed:`, error.message);
                            
                            // 마지막 시도에서도 실패하면
                            if (i === maxRetries - 1) {
                                console.error("Failed to fetch transaction details after retries:", err);
                                alert(`트랜잭션 제출됨: ${result.digest}\n\n트랜잭션이 아직 블록체인에 포함되지 않았을 수 있습니다.\n잠시 후 수동으로 새로고침해주세요.`);
                            }
                        }
                    }
                } else {
                    // digest가 없거나 client가 없는 경우
                    console.log("Full Result:", JSON.stringify(result, null, 2));
                    alert(`트랜잭션 제출됨: ${result.digest || "알 수 없음"}\n콘솔에서 상세 정보를 확인하세요.`);
                }
            },
            onError: (err) => {
                console.error("Transaction Failed:", err);
                console.error("Error Details:", JSON.stringify(err, null, 2));
                const errorMessage = err instanceof Error ? err.message : String(err);
                alert(`❌ 요청 실패!\n에러: ${errorMessage}\n\nSUI 잔액이 부족할 수 있습니다.`);
            }
        });
    };

    // 3. 정답 커밋 (Commit Guess)
    const handleCommit = () => {
        if (!guessInput) return;
        
        // Keccak256(Answer + Salt)
        const combined = ethers.toUtf8Bytes(guessInput + saltInput);
        const hash = ethers.keccak256(combined);
        const hashBytes = ethers.getBytes(hash);

        const txb = new Transaction();
        txb.moveCall({
            target: `${packageId}::${moduleName}::commit_guess`,
            arguments: [
                txb.object(gameId),
                txb.pure.vector("u8", Array.from(hashBytes)), // vector<u8> 타입
                txb.object("0x6") // Clock Object
            ]
        });

        signAndExecute({ transaction: txb }, {
            onSuccess: () => alert("정답 커밋 완료! 잠시 후 공개(Reveal)하세요."),
            onError: (err) => {
                console.error("Commit Failed:", err);
                alert(`커밋 실패: ${err.message || err}`);
            }
        });
    };

    // 4. 정답 공개 및 승리 (Solve / Reveal)
    const handleSolve = () => {
        const txb = new Transaction();
        
        // 정답 문자열과 Salt를 바이트 배열로 변환
        const answerBytes = Array.from(ethers.toUtf8Bytes(guessInput));
        const saltBytes = Array.from(ethers.toUtf8Bytes(saltInput));

        txb.moveCall({
            target: `${packageId}::${moduleName}::solve`,
            arguments: [
                txb.object(gameId),
                txb.pure.vector("u8", answerBytes), // vector<u8> 타입
                txb.pure.vector("u8", saltBytes), // vector<u8> 타입
                txb.pure.vector("u8", []), // Game Salt (현재 미사용)
                txb.object("0x6")
            ]
        });

        signAndExecute({ transaction: txb }, {
            onSuccess: () => {
                alert("정답 제출 완료! 결과를 확인하세요.");
                refetch(); // 데이터 새로고침
            },
            onError: (err) => {
                console.error("Solve Failed:", err);
                alert(`실패: ${err.message || err}`);
            }
        });
    };

    return (
        <div style={{ padding: 20 }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
                <h1>🧩 Mosaic Reveal Game</h1>
                <ConnectButton />
            </header>

            {isSolved && <h2 style={{color: 'green'}}>🎉 게임 종료! 정답자가 나왔습니다.</h2>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 5, maxWidth: 500 }}>
                {Array.from({ length: 100 }).map((_, i) => {
                    // 👇 [수정] 헬퍼 함수 사용
                    const tileData = Array.isArray(decryptedKeys) ? decryptedKeys[i] : undefined;
                    const isRevealed = checkIsRevealed(tileData);
                    const aesKeyHex = extractAesKeyHex(tileData);
                    const blobId = manifest?.tiles?.[i];

                    return (
                        <Tile
                            key={i}
                            index={i}
                            isRevealed={isRevealed}
                            aesKeyHex={aesKeyHex}
                            blobId={blobId}
                            onClick={() => !isRevealed && handleTileClick(i)}
                        />
                    );
                })}
            </div>

            <div style={{ marginTop: 30, borderTop: '1px solid #eee', paddingTop: 20 }}>
                <h3>🕵️ 정답 맞추기</h3>
                <input 
                    type="text" 
                    placeholder="정답 입력 (예: sui)" 
                    value={guessInput}
                    onChange={(e) => setGuessInput(e.target.value)}
                    style={{ padding: 10, marginRight: 10 }}
                />
                <input 
                    type="text" 
                    placeholder="비밀 Salt (기억하세요!)" 
                    value={saltInput}
                    onChange={(e) => setSaltInput(e.target.value)}
                    style={{ padding: 10, marginRight: 10 }}
                />
                <br/><br/>
                <button onClick={handleCommit} style={{ marginRight: 10 }}>1. 커밋 (찜하기)</button>
                <button onClick={handleSolve}>2. 정답 제출 (공개)</button>
            </div>
        </div>
    );
}

export default App;